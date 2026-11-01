import { validateCsrfToken, type AuthTransaction } from '@maronn-openid-connect/core';
import { type LoginError, transactionErrorOutcome } from '../screen.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'validate-csrf-token',
  endpoint: 'login',
  kind: 'validate',
  label: 'Check csrf_token against the transaction',
  function: 'validateLoginCsrfToken',
  calls: ['validateCsrfToken'],
  consumes: ['transaction', 'csrfToken'],
  produces: [],
  removable: false,
});

/**
 * [validate-csrf-token] The csrf_token says the submission came from the form
 * the OP rendered for exactly this transaction; any other token is refused
 * (403) on the OP's own error page.
 */
export function validateLoginCsrfToken(
  transaction: AuthTransaction,
  csrfToken: string,
): LoginError | undefined {
  try {
    validateCsrfToken(transaction, csrfToken);
    return undefined;
  } catch (error) {
    return transactionErrorOutcome(error);
  }
}
