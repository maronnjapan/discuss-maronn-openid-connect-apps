import type { AuthTransaction, AuthorizationCodeData } from '@maronn-openid-connect/core';
import type { AuthSessionInfo } from '../../../store.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'record-consent',
  endpoint: 'consent',
  kind: 'persist',
  label: 'Record the consent and the grant',
  spec: 'OIDC Core 1.0 §3.1.2.4',
  function: 'recordConsentDecision',
  calls: ['consentResolver.recordConsent', 'consentResolver.recordGrant'],
  consumes: ['transactionId', 'transaction', 'session', 'authCodeData', 'grantedScope'],
  produces: [],
  removable: false,
});

/**
 * [record-consent] Record the consent and the grant so a later prompt=none (or
 * non-interactive SSO) request can confirm it without UI, then clear the
 * per-transaction hand-off. Routed through the consentResolver so a custom
 * store can override persistence. Only the hand-off is cleared; the browser
 * (OP) session persists so SSO keeps working. OIDC Core 1.0 §3.1.2.1 / §3.1.2.4
 */
export async function recordConsentDecision(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
  session: AuthSessionInfo,
  // The grant of the code — or of the tokens the Implicit Flow returns in its place.
  grant: Pick<AuthorizationCodeData, 'grantId'>,
  grantedScope: string[],
): Promise<void> {
  const authSessionStore = c.get('authSessionStore');
  const consentResolver = c.get('consentResolver');
  await consentResolver.recordConsent?.(session.subject, transaction.clientId, grantedScope);
  await consentResolver.recordGrant?.(
    session.subject,
    transaction.clientId,
    grant.grantId,
  );
  await authSessionStore.delete(transactionId);
}
