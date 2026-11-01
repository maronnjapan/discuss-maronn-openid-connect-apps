import type { AuthTransaction } from '@maronn-openid-connect/core';
import type { ConsentOutcome } from '../screen.js';
import { buildConsentRedirect } from './build-authorization-response.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'deny-authorization',
  endpoint: 'consent',
  kind: 'respond',
  label: 'Deny: answer access_denied',
  spec: 'OIDC Core 1.0 §3.1.2.6',
  function: 'denyAuthorizationRequest',
  calls: ['buildConsentRedirect'],
  consumes: ['transactionId', 'transaction', 'issuer'],
  produces: ['outcome'],
  removable: false,
});

/**
 * [deny-authorization] The End-User denied the request: finish the transaction
 * and answer access_denied to the client. OIDC Core 1.0 §3.1.2.6
 */
export async function denyAuthorizationRequest(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
  issuer: string,
): Promise<ConsentOutcome> {
  const transactionStore = c.get('transactionStore');
  const authSessionStore = c.get('authSessionStore');
  await transactionStore.delete('auth_txn:' + transactionId);
  await authSessionStore.delete(transactionId);
  // The error goes back in the response mode the request asked for: JARM
  // (§2.1) signs it too, so the client can verify that the OP it trusts is
  // the one that denied the request.
  return buildConsentRedirect(c, transaction, transaction.redirectUri, {
    error: 'access_denied',
    state: transaction.state,
  }, issuer);
}
