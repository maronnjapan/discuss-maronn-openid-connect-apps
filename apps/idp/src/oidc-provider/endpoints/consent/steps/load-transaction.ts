import { getAuthTransaction, type AuthTransaction } from '@maronn-openid-connect/core';
import { parseTransactionId } from '../../../cookies.js';
import { type ConsentError, transactionErrorOutcome } from '../screen.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'load-transaction',
  endpoint: 'consent',
  kind: 'resolve',
  label: 'Load the transaction named by the cookie',
  spec: 'OIDC Core 1.0 §3.1.2.4',
  function: 'loadTransaction',
  calls: ['parseTransactionId', 'getAuthTransaction'],
  consumes: [],
  produces: ['transactionId', 'transaction'],
  removable: false,
});

/**
 * [load-transaction] The transaction this browser is in the middle of: the id
 * from the transaction cookie /authorize set (buildTransactionCookie() in
 * cookies.ts), loaded from the store. Returns the error to show instead when
 * there is none. OIDC Core 1.0 §3.1.2.4
 */
export async function loadTransaction(
  c: any,
): Promise<{ transactionId: string; transaction: AuthTransaction } | ConsentError> {
  const transactionId = parseTransactionId(c.req.header('Cookie') ?? null);
  if (!transactionId) {
    return {
      kind: 'error',
      error: 'No authorization request is in progress in this browser. Start again from the application.',
      statusCode: 400,
    };
  }
  const transactionStore = c.get('transactionStore');
  try {
    return { transactionId, transaction: await getAuthTransaction(transactionId, transactionStore) };
  } catch (error) {
    return transactionErrorOutcome(error);
  }
}
