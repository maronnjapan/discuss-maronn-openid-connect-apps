import { getAuthTransaction, type AuthTransaction } from '@maronn-openid-connect/core';
import { parseTransactionId } from '../../../cookies.js';
import { type LoginError, transactionErrorOutcome } from '../screen.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'load-transaction',
  endpoint: 'login',
  kind: 'resolve',
  label: 'Load the transaction named by the cookie',
  spec: 'OIDC Core 1.0 §3.1.2.3',
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
 * there is none. OIDC Core 1.0 §3.1.2.3
 */
export async function loadTransaction(
  c: any,
): Promise<{ transactionId: string; transaction: AuthTransaction } | LoginError> {
  const transactionId = parseTransactionId(c.req.header('Cookie') ?? null);
  if (!transactionId) {
    return {
      kind: 'error',
      error: 'No authorization request is in progress in this browser. Start again from the application.',
      statusCode: 400,
    };
  }
  const loaded = await loadTransactionById(c, transactionId);
  if ('kind' in loaded) return loaded;
  return { transactionId, transaction: loaded.transaction };
}

/**
 * Load the transaction with a known id from the store, or the error to show
 * when it is unknown, finished or expired.
 */
export async function loadTransactionById(
  c: any,
  transactionId: string,
): Promise<{ transaction: AuthTransaction } | LoginError> {
  const transactionStore = c.get('transactionStore');
  try {
    return { transaction: await getAuthTransaction(transactionId, transactionStore) };
  } catch (error) {
    return transactionErrorOutcome(error);
  }
}
