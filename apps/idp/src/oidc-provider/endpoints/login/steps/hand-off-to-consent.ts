import { buildSessionCookie } from '../../../cookies.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'hand-off-to-consent',
  endpoint: 'login',
  kind: 'persist',
  label: 'Store the authenticated subject for the consent step',
  function: 'handOffToConsent',
  calls: ['buildSessionCookie'],
  consumes: ['transactionId', 'user', 'sessionId', 'authTime'],
  produces: ['outcome'],
  removable: false,
});

/**
 * [hand-off-to-consent] Store the authenticated subject for the consent step
 * (the per-transaction hand-off) and answer with the session cookie. The
 * sessionId travels along for the online refresh token: the authorization code
 * the consent step issues inherits this session, so the refresh token stops
 * working at logout.
 */
export async function handOffToConsent(
  c: any,
  transactionId: string,
  subject: string,
  sessionId: string,
  authTime: number,
): Promise<{ kind: 'authenticated'; cookies: string[] }> {
  const authSessionStore = c.get('authSessionStore');
  await authSessionStore.set(transactionId, { subject, authTime, sessionId });
  return { kind: 'authenticated', cookies: [buildSessionCookie(sessionId)] };
}
