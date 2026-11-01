import type { AuthTransaction } from '@maronn-openid-connect/core';
import { parseSessionId } from '../../../cookies.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'discard-session-for-fresh-login',
  endpoint: 'login',
  kind: 'persist',
  label: 'prompt=login: discard the existing session',
  spec: 'OIDC Core 1.0 §3.1.2.1',
  function: 'discardSessionForFreshLogin',
  consumes: ['transactionId', 'transaction'],
  produces: [],
  removable: false,
});

/**
 * [discard-session-for-fresh-login] prompt=login (and prompt=select_account)
 * requires fresh authentication: discard any existing transaction hand-off AND
 * browser session before the new one is established. OIDC Core 1.0 §3.1.2.1
 * (prompt is a space-delimited list).
 */
export async function discardSessionForFreshLogin(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
): Promise<void> {
  const promptValues = transaction.prompt?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (!promptValues.includes('login') && !promptValues.includes('select_account')) return;
  const authSessionStore = c.get('authSessionStore');
  const browserSessionStore = c.get('browserSessionStore');
  await authSessionStore.delete(transactionId);
  const existingSessionId = parseSessionId(c.req.header('Cookie') ?? null);
  if (existingSessionId) await browserSessionStore.delete(existingSessionId);
}
