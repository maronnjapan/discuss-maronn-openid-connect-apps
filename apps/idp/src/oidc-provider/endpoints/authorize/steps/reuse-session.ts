import {
  type AuthTransaction,
  requiresReauthentication,
  type SessionInfo,
} from '@maronn-openid-connect/core';
import { buildTransactionCookie } from '../../../cookies.js';
import { resolveGrantableScopes } from '../../../scopes.js';
import type { AuthorizationOutcome } from '../outcome.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'reuse-session',
  endpoint: 'authorize',
  kind: 'dispatch',
  label: 'Single Sign-On: reuse the active OP session',
  spec: 'OIDC Core 1.0 §3.1.2.3',
  function: 'reuseExistingSession',
  calls: ['requiresReauthentication', 'resolveGrantableScopes', 'consentResolver.hasConsent'],
  consumes: ['promptValues', 'transactionId', 'transaction', 'transactionTtlSeconds', 'verifiedHintSubject'],
  produces: ['session'],
  removable: true,
});

/**
 * Single Sign-On: reuse the active OP session instead of showing the login
 * screen. OIDC Core 1.0 §3.1.2.3
 *
 * - prompt=login / prompt=select_account always force re-authentication.
 * - When max_age is requested, the session must also satisfy the freshness
 *   bound (§3.1.2.1); when it is absent, any active session is reused.
 * - The session must belong to the End-User id_token_hint names (§3.1.2.1):
 *   otherwise the request falls to the login screen rather than silently
 *   issuing a code for another End-User.
 *
 * Returns undefined when there is no session to reuse (continue on the login
 * screen); the session when consent was already granted (the code is issued);
 * or the consent outcome when the End-User still has to decide (prompt=consent
 * MUST re-display the consent UI).
 */
export async function reuseExistingSession(
  c: any,
  input: {
    promptValues: string[];
    transactionId: string;
    transaction: AuthTransaction;
    transactionTtlSeconds: number;
    verifiedHintSubject: string | undefined;
  },
): Promise<{ session: SessionInfo } | AuthorizationOutcome | undefined> {
  const { promptValues, transactionId, transaction, transactionTtlSeconds, verifiedHintSubject } = input;
  if (promptValues.includes('login') || promptValues.includes('select_account')) return undefined;
  const sessionResolver = c.get('sessionResolver');
  if (!sessionResolver) return undefined;

  const existingSession = await sessionResolver.resolve(c.req.raw);
  const sessionIsFresh =
    existingSession !== null &&
    (transaction.maxAge === undefined ||
      !requiresReauthentication(transaction.maxAge, existingSession.authTime));
  // OIDC Core 1.0 §3.1.2.1: id_token_hint が指す End-User でなければ既存
  // セッションを再利用しない。これが無いと「セッションは User B / hint は
  // User A」の要求に対し B の認可コードを黙って発行してしまう。
  // 不一致はエラーにせずログイン画面へ落とし、正しい End-User として認証さ
  // せる（login_required を即返すかは方針判断に委ねる）。
  const hintMatchesSession =
    verifiedHintSubject === undefined ||
    (existingSession !== null && verifiedHintSubject === existingSession.subject);
  if (!existingSession || !sessionIsFresh || !hintMatchesSession) return undefined;

  // OIDC Core 1.0 §3.1.2.1: prompt=consent MUST re-display the consent UI.
  // Otherwise, if the user already granted (a superset of) the requested
  // scopes to this client, skip the consent screen and issue the code
  // directly — the interactive analogue of the prompt=none silent path.
  const consentResolver = c.get('consentResolver');

  // Apply the scope policy before the consent lookup below, for the same
  // reason as the prompt=none path. The narrowed value is only held in
  // memory: the interactive branch hands the transaction back to
  // /consent, which applies the policy again with the authenticated
  // subject it reads out of authSessionStore.
  transaction.scope = (await resolveGrantableScopes(
    transaction.scope.split(' ').filter(Boolean),
    existingSession.subject,
  )).join(' ');
  const requestedScopes = transaction.scope.split(' ').filter(Boolean);
  const consentAlreadyGranted =
    !promptValues.includes('consent') &&
    consentResolver !== undefined &&
    (await consentResolver.hasConsent(
      existingSession.subject,
      transaction.clientId,
      requestedScopes,
    ));
  if (consentAlreadyGranted) {
    return { session: existingSession };
  }

  const authSessionStore = c.get('authSessionStore');
  await authSessionStore.set(transactionId, {
    subject: existingSession.subject,
    authTime: existingSession.authTime,
    // consent 画面を経由しても online refresh token の束縛先を見失わないよう、
    // login → consent の受け渡しに sessionId も載せる。
    sessionId: existingSession.sessionId,
  });
  // Continue on the consent screen (endpoints/consent/page.tsx), which finds the
  // transaction through the cookie that travels with this answer.
  return {
    kind: 'consent',
    cookies: [buildTransactionCookie(transactionId, transactionTtlSeconds)],
  };
}
