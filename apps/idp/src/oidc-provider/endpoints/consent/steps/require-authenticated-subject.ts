import type { AuthSessionInfo } from '../../../store.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'require-authenticated-subject',
  endpoint: 'consent',
  kind: 'resolve',
  label: 'Require the subject the login step stored',
  function: 'requireAuthenticatedSubject',
  consumes: ['transactionId'],
  produces: ['session'],
  removable: false,
});

/**
 * [require-authenticated-subject] The subject the login step stored for this
 * transaction (the per-transaction hand-off). Without one the login step was
 * skipped or has expired, and no code may be issued.
 */
export async function requireAuthenticatedSubject(
  c: any,
  transactionId: string,
): Promise<AuthSessionInfo | undefined> {
  const authSessionStore = c.get('authSessionStore');
  return (await authSessionStore.get(transactionId)) ?? undefined;
}
