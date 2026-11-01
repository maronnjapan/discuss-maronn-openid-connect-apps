import {
  completeAuthTransaction,
  createAuthorizationCode,
  type AuthTransaction,
} from '@maronn-openid-connect/core';
import type { AuthSessionInfo } from '../../../store.js';
import { resolveGrantableScopes } from '../../../scopes.js';
import type { ConsentedAuthorization } from '../screen.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'issue-authorization-code',
  endpoint: 'consent',
  kind: 'issue',
  label: 'Issue the authorization code',
  spec: 'OIDC Core 1.0 §3.1.2.5 / §3.1.3.1',
  function: 'issueConsentedAuthorizationCode',
  calls: ['completeAuthTransaction', 'resolveGrantableScopes', 'createAuthorizationCode'],
  consumes: ['transactionId', 'transaction', 'session'],
  produces: ['responseParams', 'authCodeData', 'grantedScope'],
  removable: false,
});

/**
 * [issue-authorization-code] Finish the transaction and issue the
 * authorization code for the granted scope. OIDC Core 1.0 §3.1.2.5 / §3.1.3.1
 * (the code lives config.authorizationCodeTtl seconds, 300 by default).
 *
 * transaction.scope already went through applyOfflineAccessPolicy when the
 * authorization request was validated: whether offline_access may be granted
 * (OIDC Core 1.0 §11 prompt=consent, and refresh_token among the client's
 * registered grant_types) was settled there, so it is not filtered again.
 */
export async function issueConsentedAuthorizationCode(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
  session: AuthSessionInfo,
): Promise<ConsentedAuthorization> {
  const config = c.get('config');
  const transactionStore = c.get('transactionStore');
  const authCodeStore = c.get('authCodeStore');
  const responseParams = await completeAuthTransaction(transactionId, transaction, transactionStore);
  // Apply the scope policy (resolveGrantableScopes in scopes.ts — the place to
  // write per-user filtering). A dropped scope narrows the grant rather than
  // failing the request: RFC 6749 §3.3 lets the authorization server issue a
  // narrower scope, and the token response reports what was granted.
  const grantedScope = await resolveGrantableScopes(
    transaction.scope.split(' ').filter(Boolean),
    session.subject,
  );
  const authCodeData = await createAuthorizationCode({
    authorizationResponse: { ...responseParams, scope: grantedScope },
    subject: session.subject,
    authTime: session.authTime,
    // Bind the online refresh token to this login session (the sessionId the
    // login step put on the auth session): logging out revokes that token too.
    sessionId: session.sessionId,
    ttlSeconds: config.authorizationCodeTtl,
  });
  await authCodeStore.set(authCodeData.code, authCodeData);
  return { responseParams, authCodeData, grantedScope };
}
