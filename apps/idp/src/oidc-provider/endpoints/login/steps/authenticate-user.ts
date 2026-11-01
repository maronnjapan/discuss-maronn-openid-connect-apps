import { step } from '../../step.js';

export const meta = step({
  id: 'authenticate-user',
  endpoint: 'login',
  kind: 'validate',
  label: 'Check the credentials',
  function: 'authenticateEndUser',
  calls: ['userStore.authenticate'],
  consumes: ['username', 'password'],
  produces: ['user'],
  removable: false,
});

/**
 * [authenticate-user] Check the credentials against the user store (or the
 * authenticateUser function app.ts put on the request context). Returns the
 * End-User, or undefined when the credentials are wrong.
 */
export async function authenticateEndUser(
  c: any,
  username: string,
  password: string,
): Promise<{ sub: string } | undefined> {
  const authenticateUser = c.get('authenticateUser');
  return (await authenticateUser(username, password)) ?? undefined;
}
