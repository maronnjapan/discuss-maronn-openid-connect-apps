/**
 * The app's own session: a random value in an HttpOnly cookie, and its
 * SHA-256 with the user's identity in D1 (sessions). The session lasts
 * SESSION_TTL from sign-in; signing in again starts a new one.
 *
 * Cookie names differ from the IdP's (cookies are not separated by port, so
 * on localhost the two apps would otherwise share them). With an HTTPS
 * origin the names carry the __Host- prefix.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { randomToken, sha256Hex } from '../crypto.js';
import { createSession, findSession, now, takeSession, type SessionRow } from '../db.js';
import type { AppConfig } from '../env.js';
import type { SignedInUser } from './oidc.js';

export const SESSION_TTL = 12 * 60 * 60;

export interface CurrentUser {
  sub: string;
  name: string | null;
  email: string | null;
}

export type AppVariables = { config: AppConfig; user: CurrentUser };

function cookieName(config: AppConfig, base: string): string {
  return config.secureCookies ? `__Host-${base}` : base;
}

export const sessionCookieName = (config: AppConfig) => cookieName(config, 'planner_session');
export const loginStateCookieName = (config: AppConfig) => cookieName(config, 'planner_login');

function cookieOptions(config: AppConfig, maxAge: number) {
  return { httpOnly: true, secure: config.secureCookies, sameSite: 'Lax' as const, path: '/', maxAge };
}

export function setLoginStateCookie(c: Context, config: AppConfig, state: string, maxAge: number): void {
  setCookie(c, loginStateCookieName(config), state, cookieOptions(config, maxAge));
}

export function readLoginStateCookie(c: Context, config: AppConfig): string | undefined {
  return getCookie(c, loginStateCookieName(config));
}

export function clearLoginStateCookie(c: Context, config: AppConfig): void {
  deleteCookie(c, loginStateCookieName(config), { path: '/', secure: config.secureCookies });
}

export async function startSession(c: Context, db: D1Database, config: AppConfig, user: SignedInUser): Promise<void> {
  const value = randomToken();
  const created = now();
  const row: SessionRow = {
    id_hash: await sha256Hex(value),
    sub: user.sub,
    name: user.name,
    email: user.email,
    id_token: user.idToken,
    created_at: created,
    expires_at: created + SESSION_TTL,
  };
  await createSession(db, row);
  setCookie(c, sessionCookieName(config), value, cookieOptions(config, SESSION_TTL));
}

export async function currentSession(c: Context, db: D1Database, config: AppConfig): Promise<SessionRow | null> {
  const value = getCookie(c, sessionCookieName(config));
  if (!value) return null;
  return findSession(db, await sha256Hex(value));
}

/** Ends the session and returns it (for the id_token_hint of the IdP logout). */
export async function endSession(c: Context, db: D1Database, config: AppConfig): Promise<SessionRow | null> {
  const value = getCookie(c, sessionCookieName(config));
  deleteCookie(c, sessionCookieName(config), { path: '/', secure: config.secureCookies });
  if (!value) return null;
  return takeSession(db, await sha256Hex(value));
}

/** A path inside this app to return to after sign-in; anything else becomes "/". */
export function safeReturnTo(value: string | undefined | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}

/**
 * Requires a signed-in user. A page request without a session is sent to
 * sign-in and comes back to the same page; any other request gets 401.
 */
export function requireUser(): MiddlewareHandler<{ Bindings: { DB: D1Database }; Variables: AppVariables }> {
  return async (c, next) => {
    const config = c.get('config');
    const session = await currentSession(c, c.env.DB, config);
    if (!session) {
      if (c.req.method === 'GET' && !c.req.path.startsWith('/api/')) {
        const url = new URL(c.req.url);
        return c.redirect(`/auth/login?return_to=${encodeURIComponent(url.pathname + url.search)}`, 302);
      }
      return c.json({ error: 'unauthorized' }, 401);
    }
    c.set('user', { sub: session.sub, name: session.name, email: session.email });
    await next();
  };
}
