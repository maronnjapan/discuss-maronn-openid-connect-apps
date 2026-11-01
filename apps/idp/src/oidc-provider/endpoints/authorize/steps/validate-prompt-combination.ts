import type { AuthTransaction } from '@maronn-openid-connect/core';
import { type AuthorizationOutcome, buildErrorResponse } from '../outcome.js';
import type { AuthorizationResponseMode } from '../response-mode.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'validate-prompt-combination',
  endpoint: 'authorize',
  kind: 'validate',
  label: 'Reject prompt=none combined with other values',
  spec: 'OIDC Core 1.0 §3.1.2.1',
  function: 'rejectCombinedPromptNone',
  consumes: ['transactionId', 'transaction', 'issuer', 'responseMode'],
  optional: ['responseMode'],
  produces: ['promptValues'],
  removable: false,
});

/**
 * OIDC Core 1.0 §3.1.2.1: prompt=none must not be combined with other values.
 * Returns the redirectable error outcome (and drops the transaction) when it
 * is; undefined otherwise.
 */
export async function rejectCombinedPromptNone(
  c: any,
  promptValues: string[],
  transactionId: string,
  transaction: AuthTransaction,
  issuer: string,
  responseMode: AuthorizationResponseMode | undefined,
): Promise<AuthorizationOutcome | undefined> {
  if (!(promptValues.includes('none') && promptValues.length > 1)) return undefined;
  const transactionStore = c.get('transactionStore');
  await transactionStore.delete('auth_txn:' + transactionId);
  return {
    kind: 'authorization_response',
    response: await buildErrorResponse(responseMode, transaction.redirectUri, 'invalid_request', transaction.state, 'prompt=none must not be combined with other prompt values', issuer),
  };
}
