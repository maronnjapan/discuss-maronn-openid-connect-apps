/** The Worker's bindings and the settings read from them. */
import { BEARER_TOKEN_HASH_PATTERN } from './auth/routine-token.js';

export interface Bindings {
  DB: D1Database;
  ASSETS: Fetcher;
  /**
   * Optional service binding to the IdP Worker. When present, the back-channel
   * requests to the issuer (discovery, token, userinfo, JWKS) go through it
   * instead of the public internet.
   */
  IDP?: Fetcher;
  /** The public origin of this app, e.g. https://planner.example.workers.dev. */
  APP_ORIGIN: string;
  OIDC_ISSUER: string;
  OIDC_CLIENT_ID: string;
  /** Secret. */
  OIDC_CLIENT_SECRET?: string;
  /** Secret. The URL of the routine's API trigger (…/routines/trig_…/fire). */
  ROUTINE_FIRE_URL?: string;
  /** Secret. The routine's bearer token (sk-ant-oat01-…). */
  ROUTINE_TOKEN?: string;
  /**
   * Secret. The base64url SHA-256 of the token the routine's requests carry
   * (Authorization: Bearer, added by the network secret of its environment).
   */
  ROUTINE_BEARER_TOKEN_HASH?: string;
  /** Comma-separated subs allowed to use the app. Empty: every user of the IdP. */
  ALLOWED_SUBS?: string;
  /** Routine runs a user may start per hour. Default 10. */
  RUNS_PER_HOUR_LIMIT?: string;
  /** Minutes to wait for the routine's result before giving up. Default 360. */
  RUN_TIMEOUT_MINUTES?: string;
}

export interface AppConfig {
  appOrigin: string;
  secureCookies: boolean;
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  routine: { fireUrl: string; token: string } | null;
  /** The hash of the routine's bearer token; null when it is not set (every result is refused). */
  routineBearerTokenHash: string | null;
  allowedSubs: string[];
  runsPerHourLimit: number;
  runTimeoutSeconds: number;
}

export class ConfigError extends Error {}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readConfig(env: Bindings): AppConfig {
  const appOrigin = (env.APP_ORIGIN ?? '').replace(/\/+$/, '');
  const issuer = (env.OIDC_ISSUER ?? '').replace(/\/+$/, '');
  if (!URL.canParse(appOrigin)) throw new ConfigError('APP_ORIGIN が設定されていないか、URL ではありません。');
  if (!URL.canParse(issuer)) throw new ConfigError('OIDC_ISSUER が設定されていないか、URL ではありません。');
  if (!env.OIDC_CLIENT_ID) throw new ConfigError('OIDC_CLIENT_ID が設定されていません。');
  if (!env.OIDC_CLIENT_SECRET) throw new ConfigError('OIDC_CLIENT_SECRET（Secret）が設定されていません。');

  const fireUrl = env.ROUTINE_FIRE_URL?.trim();
  const token = env.ROUTINE_TOKEN?.trim();
  const bearerTokenHash = env.ROUTINE_BEARER_TOKEN_HASH?.trim() || null;
  if (bearerTokenHash !== null && !BEARER_TOKEN_HASH_PATTERN.test(bearerTokenHash)) {
    throw new ConfigError('ROUTINE_BEARER_TOKEN_HASH（Secret）は、トークンの SHA-256 を base64url にした 43 文字にしてください。');
  }
  return {
    appOrigin,
    secureCookies: appOrigin.startsWith('https://'),
    issuer,
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET,
    redirectUri: `${appOrigin}/auth/callback`,
    postLogoutRedirectUri: `${appOrigin}/signed-out`,
    routine: fireUrl && token && URL.canParse(fireUrl) ? { fireUrl, token } : null,
    routineBearerTokenHash: bearerTokenHash,
    allowedSubs: (env.ALLOWED_SUBS ?? '')
      .split(',')
      .map((sub) => sub.trim())
      .filter((sub) => sub.length > 0),
    runsPerHourLimit: positiveInteger(env.RUNS_PER_HOUR_LIMIT, 10),
    runTimeoutSeconds: positiveInteger(env.RUN_TIMEOUT_MINUTES, 360) * 60,
  };
}
