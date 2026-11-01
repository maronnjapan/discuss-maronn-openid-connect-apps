import { buildTransactionCookie } from '../../../cookies.js';
import type { AuthorizationOutcome } from '../outcome.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'continue-to-login',
  endpoint: 'authorize',
  kind: 'respond',
  label: 'Continue on the login screen',
  spec: 'OIDC Core 1.0 §3.1.2.3',
  function: 'continueToLogin',
  calls: ['buildTransactionCookie'],
  consumes: ['transactionId', 'transactionTtlSeconds'],
  produces: [],
  removable: false,
});

/**
 * Interactive authentication: continue on the login screen (endpoints/login/page.tsx;
 * prompt=login forces re-authentication there), which finds the transaction
 * through the cookie that travels with this answer. OIDC Core 1.0 §3.1.2.3
 */
export function continueToLogin(transactionId: string, transactionTtlSeconds: number): AuthorizationOutcome {
  return { kind: 'login', cookies: [buildTransactionCookie(transactionId, transactionTtlSeconds)] };
}
