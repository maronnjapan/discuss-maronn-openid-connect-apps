import { handleLoginFailure, type AuthTransaction } from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'record-login-failure',
  endpoint: 'login',
  kind: 'persist',
  label: 'Count the failed attempt (lockout)',
  function: 'recordLoginFailure',
  calls: ['handleLoginFailure'],
  consumes: ['transactionId', 'transaction'],
  produces: [],
  removable: false,
});

/**
 * [record-login-failure] Count the failed attempt on the transaction. Once the
 * attempts are used up the transaction is deleted (canRetry: false) and no
 * further attempt is accepted.
 */
export async function recordLoginFailure(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
): Promise<{ canRetry: boolean; remainingAttempts: number }> {
  const transactionStore = c.get('transactionStore');
  const failure = await handleLoginFailure(transactionId, transaction, transactionStore);
  return {
    canRetry: failure.canRetry,
    remainingAttempts: failure.maxAttempts - failure.failedAttempts,
  };
}
