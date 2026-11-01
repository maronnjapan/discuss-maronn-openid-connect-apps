/** @jsxImportSource hono/jsx */
/** Sign-in, its callback, sign-out, and the page after sign-out. */
import { Hono } from 'hono';
import { endSessionUrl, finishLogin, LoginError, startLogin } from '../auth/oidc.js';
import {
  clearLoginStateCookie,
  endSession,
  readLoginStateCookie,
  safeReturnTo,
  setLoginStateCookie,
  startSession,
  type AppVariables,
} from '../auth/session.js';
import { saveLoginAttempt, takeLoginAttempt } from '../db.js';
import type { Bindings } from '../env.js';
import { ErrorPage, SignedOutPage } from '../views/pages.js';

export const authRoutes = new Hono<{ Bindings: Bindings; Variables: AppVariables }>();

authRoutes.get('/auth/login', async (c) => {
  const config = c.get('config');
  const login = await startLogin(config, c.env);
  await saveLoginAttempt(c.env.DB, {
    state: login.state,
    code_verifier: login.codeVerifier,
    nonce: login.nonce,
    return_to: safeReturnTo(c.req.query('return_to')),
    expires_at: login.expiresAt,
  });
  // The state is also kept in a cookie of this browser, so a callback that
  // carries someone else's state (login CSRF) is rejected.
  setLoginStateCookie(c, config, login.state, login.expiresAt - Math.floor(Date.now() / 1000));
  return c.redirect(login.url, 302);
});

authRoutes.get('/auth/callback', async (c) => {
  const config = c.get('config');
  const cookieState = readLoginStateCookie(c, config);
  clearLoginStateCookie(c, config);
  const callbackUrl = new URL(c.req.url);
  const state = callbackUrl.searchParams.get('state');
  const loginAgain = { href: '/auth/login', label: 'もう一度ログインする' };

  if (!cookieState || !state || cookieState !== state) {
    return c.html(
      <ErrorPage title="ログインできませんでした" message="ログインの要求がこのブラウザから始まったものと確認できませんでした。" action={loginAgain} />,
      400,
    );
  }
  const attempt = await takeLoginAttempt(c.env.DB, state);
  if (!attempt) {
    return c.html(
      <ErrorPage title="ログインできませんでした" message="ログインの要求が期限切れか、すでに使われています。" action={loginAgain} />,
      400,
    );
  }

  // Build the URL the IdP redirected to from APP_ORIGIN, so the redirect_uri
  // check does not depend on how the request reached the Worker.
  const responseUrl = new URL(config.redirectUri);
  responseUrl.search = callbackUrl.search;

  try {
    const user = await finishLogin(config, c.env, responseUrl, {
      state: attempt.state,
      codeVerifier: attempt.code_verifier,
      nonce: attempt.nonce,
    });
    if (config.allowedSubs.length > 0 && !config.allowedSubs.includes(user.sub)) {
      return c.html(
        <ErrorPage title="利用できません" message={`ユーザー ${user.sub} にはこのアプリの利用が許可されていません。`} />,
        403,
      );
    }
    await startSession(c, c.env.DB, config, user);
    return c.redirect(safeReturnTo(attempt.return_to), 302);
  } catch (error) {
    console.warn('[planner] login failed:', error instanceof Error ? `${error.name}: ${error.message}` : error);
    const message = error instanceof LoginError ? error.message : 'IdP とのやり取りでエラーが起きました。時間をおいてやり直してください。';
    return c.html(<ErrorPage title="ログインできませんでした" message={message} action={loginAgain} />, 400);
  }
});

authRoutes.post('/auth/logout', async (c) => {
  const config = c.get('config');
  const session = await endSession(c, c.env.DB, config);
  const url = await endSessionUrl(config, c.env, session?.id_token ?? null);
  return c.redirect(url ?? '/signed-out', 303);
});

authRoutes.get('/signed-out', (c) => c.html(<SignedOutPage />));
