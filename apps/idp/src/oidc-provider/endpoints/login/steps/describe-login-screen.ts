import type { AuthTransaction } from '@maronn-openid-connect/core';
import { features } from '../../../features/enabled.js';
import { loginMethodsOf } from '../../../features/feature.js';
import type { ViewResult } from '../../../views.js';
import type { LoginScreen } from '../screen.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'describe-login-screen',
  endpoint: 'login',
  kind: 'transform',
  label: 'Describe the login form',
  spec: 'OIDC Core 1.0 §3.1.2.1 (login_hint)',
  function: 'describeLoginScreen',
  consumes: ['transaction'],
  produces: ['screen'],
  removable: false,
});

/**
 * [describe-login-screen] Describe the form for a transaction (the shared part
 * of GET and a failed POST), with the other ways to sign in the features
 * offer: each login method renders itself for this transaction, or nothing
 * while it is not configured. OIDC Core 1.0 §3.1.2.1 (login_hint)
 */
export async function describeLoginScreen(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
): Promise<LoginScreen> {
  const loginMethods: ViewResult[] = [];
  for (const method of loginMethodsOf(features)) {
    const view = await method.render(c, { transactionId, transaction });
    if (view !== undefined) loginMethods.push(view);
  }
  return {
    kind: 'screen',
    csrfToken: transaction.csrfToken,
    loginHint: transaction.loginHint,
    loginMethods,
  };
}
