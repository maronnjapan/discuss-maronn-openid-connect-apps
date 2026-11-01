import { generateRandomString } from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'establish-session',
  endpoint: 'login',
  kind: 'persist',
  label: 'Establish the OP browser session',
  spec: 'OIDC Core 1.0 §3.1.2.3',
  function: 'establishBrowserSession',
  calls: ['generateRandomString'],
  consumes: ['user'],
  produces: ['sessionId', 'authTime'],
  removable: false,
});

/**
 * [establish-session] Establish the persistent browser (OP) session for the
 * authenticated subject. Its cookie travels with the answer so SSO,
 * prompt=none and max_age work on later authorization requests.
 * OIDC Core 1.0 §3.1.2.3
 */
export async function establishBrowserSession(
  c: any,
  subject: string,
): Promise<{ sessionId: string; authTime: number }> {
  const browserSessionStore = c.get('browserSessionStore');
  const authTime = Math.floor(Date.now() / 1000);
  const sessionId = await generateRandomString(32);
  await browserSessionStore.set(sessionId, { subject, authTime });
  return { sessionId, authTime };
}
