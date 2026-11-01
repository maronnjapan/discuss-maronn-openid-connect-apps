import { validateCsrfToken, type AuthTransaction } from '@maronn-openid-connect/core';
import { type ConsentError, transactionErrorOutcome } from '../screen.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'validate-csrf-token',
  endpoint: 'consent',
  kind: 'validate',
  label: 'Check csrf_token against the transaction',
  function: 'validateConsentCsrfToken',
  calls: ['validateCsrfToken'],
  consumes: ['transaction', 'csrfToken'],
  produces: [],
  removable: false,
});

/**
 * [validate-csrf-token] The csrf_token says the decision came from the form
 * the OP rendered for exactly this transaction; any other token is refused
 * (403) on the OP's own error page.
 */
export function validateConsentCsrfToken(
  transaction: AuthTransaction,
  csrfToken: string,
): ConsentError | undefined {
  try {
    validateCsrfToken(transaction, csrfToken);
    return undefined;
  } catch (error) {
    return transactionErrorOutcome(error);
  }
}
