import type { AuthTransaction } from '@maronn-openid-connect/core';
import { resolveGrantableScopes } from '../../../scopes.js';
import type { ConsentScreen } from '../screen.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'describe-consent-screen',
  endpoint: 'consent',
  kind: 'transform',
  label: 'Describe the consent form',
  function: 'describeConsentScreen',
  calls: ['resolveGrantableScopes'],
  consumes: ['transactionId', 'transaction'],
  produces: ['screen'],
  removable: false,
});

/**
 * [describe-consent-screen] Describe the form for a transaction: the
 * csrf_token, the client and the scopes this End-User is asked to grant.
 */
export async function describeConsentScreen(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
): Promise<ConsentScreen> {
  // Describe only what THIS End-User can actually grant. The subject comes
  // from the auth session that /login (or the SSO fast path) stored for this
  // transaction; without one there is nothing to apply the policy to, so the
  // request is shown as-is and submitConsent() stops on the same missing session.
  const authSessionStore = c.get('authSessionStore');
  const consentSession = await authSessionStore.get(transactionId);
  const requestedScopes = transaction.scope.split(' ').filter(Boolean);
  const displayedScopes = consentSession
    ? await resolveGrantableScopes(requestedScopes, consentSession.subject)
    : requestedScopes;

  return {
    kind: 'screen',
    csrfToken: transaction.csrfToken,
    scopes: displayedScopes,
    clientId: transaction.clientId,
  };
}
