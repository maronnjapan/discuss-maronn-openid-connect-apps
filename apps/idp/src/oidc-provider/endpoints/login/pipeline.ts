import type { LoginError, LoginOutcome, LoginScreen, LoginSubmission } from './screen.js';
import { authenticateEndUser } from './steps/authenticate-user.js';
import { describeLoginScreen } from './steps/describe-login-screen.js';
import { discardSessionForFreshLogin } from './steps/discard-session-for-fresh-login.js';
import { establishBrowserSession } from './steps/establish-session.js';
import { handOffToConsent } from './steps/hand-off-to-consent.js';
import { loadTransaction } from './steps/load-transaction.js';
import { recordLoginFailure } from './steps/record-login-failure.js';
import { rejectCrossOriginFormPost } from './steps/reject-cross-origin-post.js';
import { validateLoginCsrfToken } from './steps/validate-csrf-token.js';

/**
 * Login step (API layer: logic only).
 *
 * Everything the login screen has to decide is a step (steps/), one box of
 * `maronn-oidc graph --detail steps --endpoint login`: finding the
 * transaction through the transaction cookie (loadTransaction), the
 * csrf_token check (validateLoginCsrfToken), the credential check
 * (authenticateEndUser), the lockout (recordLoginFailure), the OP session
 * cookie (establishBrowserSession) and the hand-off to the consent step
 * (handOffToConsent). None of them builds a Response — each returns an
 * outcome, and page.tsx turns that outcome into a screen or a redirect.
 * prepareLogin() (GET) and submitLogin() (POST) run them in the order the
 * screen needs, so the UI can be changed without touching this file.
 */

/**
 * GET /login: load the transaction this browser's cookie names and describe the
 * form, or the error to show instead when there is none.
 */
export async function prepareLogin(c: any): Promise<LoginScreen | LoginError> {
  // [load-transaction] Load the transaction this browser is in
  const loaded = await loadTransaction(c);
  if ('kind' in loaded) return loaded;

  // [describe-login-screen] Describe the login form — OIDC Core 1.0 §3.1.2.1 (login_hint)
  return describeLoginScreen(c, loaded.transactionId, loaded.transaction);
}

/**
 * POST /login: check the credentials and, on success, establish the OP session.
 * The steps run in the fixed order the screen needs (the login endpoint of
 * `maronn-oidc graph --detail steps`).
 */
export async function submitLogin(c: any, input: LoginSubmission): Promise<LoginOutcome> {
  const { csrfToken, username, password } = input;

  // [reject-cross-origin-post] Refuse a form posted from another origin
  // First the browser's own statement of where the form was submitted from
  // (isSameOriginFormPost() in cookies.ts): independent of the cookie and the
  // csrf_token, so a forged POST is stopped even if both were planted.
  const sameOriginError = rejectCrossOriginFormPost(c);
  if (sameOriginError) return sameOriginError;

  // [load-transaction] The cookie says which transaction this browser is in.
  const loaded = await loadTransaction(c);
  if ('kind' in loaded) return loaded;
  const { transactionId, transaction } = loaded;

  // [validate-csrf-token] The csrf_token says the submission came from the form
  // the OP rendered for exactly that one.
  const csrfError = validateLoginCsrfToken(transaction, csrfToken);
  if (csrfError) return csrfError;

  // [authenticate-user] Check the credentials
  const user = await authenticateEndUser(c, username, password);
  if (!user) {
    // [record-login-failure] Wrong credentials: count the attempt, then either
    // lock the transaction or show the form again with the attempts left.
    const failure = await recordLoginFailure(c, transactionId, transaction);
    if (!failure.canRetry) {
      return { kind: 'locked_out' };
    }
    return {
      kind: 'invalid_credentials',
      screen: await describeLoginScreen(c, transactionId, transaction),
      remainingAttempts: failure.remainingAttempts,
    };
  }

  // [discard-session-for-fresh-login] prompt=login: discard the session first — OIDC Core 1.0 §3.1.2.1
  await discardSessionForFreshLogin(c, transactionId, transaction);

  // [establish-session] Establish the OP session — OIDC Core 1.0 §3.1.2.3
  const { sessionId, authTime } = await establishBrowserSession(c, user.sub);

  // [hand-off-to-consent] Hand the subject to the consent step
  return handOffToConsent(c, transactionId, user.sub, sessionId, authTime);
}
