import {
  type AuthTransaction,
  type ValidatedAuthorizationRequest,
  createAuthTransaction,
  generateRandomString,
} from '@maronn-openid-connect/core';
import type { AuthorizationTransaction } from '../outcome.js';
import type { AuthorizationResponseMode } from '../response-mode.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'create-transaction',
  endpoint: 'authorize',
  kind: 'persist',
  label: 'Create and store the authorization transaction',
  spec: 'OIDC Core 1.0 §3.1.2.3',
  function: 'createAuthorizationTransaction',
  calls: ['generateRandomString', 'createAuthTransaction'],
  consumes: ['validatedRequest', 'responseMode'],
  optional: ['responseMode'],
  produces: ['transactionId', 'transaction', 'transactionTtlSeconds'],
  removable: false,
});

/**
 * Create the authorization transaction and store it for the login / consent
 * steps. OIDC Core 1.0 §3.1.2.3
 *
 * csrfToken is embedded in the login / consent forms; transactionId never
 * leaves the OP except in the HttpOnly transaction cookie
 * (buildTransactionCookie() in cookies.ts).
 *
 * A response mode of a feature (JARM) is recorded on the stored transaction
 * by its name, so the consent step — which only ever sees the transaction it
 * reads back — answers in the same mode (restoreResponseMode() in
 * response-mode.ts). The store MUST persist unknown fields.
 */
export async function createAuthorizationTransaction(
  c: any,
  validatedRequest: ValidatedAuthorizationRequest,
  responseMode: AuthorizationResponseMode | undefined,
): Promise<AuthorizationTransaction> {
  const transactionStore = c.get('transactionStore');
  const csrfToken = await generateRandomString(32);
  const transaction: AuthTransaction = createAuthTransaction(validatedRequest, csrfToken);
  const transactionId = await generateRandomString(32);

  const transactionTtlSeconds = 10 * 60; // 10 minutes TTL
  await transactionStore.put(
    'auth_txn:' + transactionId,
    responseMode ? { ...transaction, responseMode: responseMode.name } : transaction,
    transactionTtlSeconds,
  );
  return { transactionId, transaction, transactionTtlSeconds };
}
