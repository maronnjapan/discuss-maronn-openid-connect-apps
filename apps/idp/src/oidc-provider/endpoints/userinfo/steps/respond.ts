import type { UserInfoEndpointResponse } from '../response.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'respond',
  endpoint: 'userinfo',
  kind: 'respond',
  label: 'Respond (no-store)',
  spec: 'RFC 6750 §5.2',
  function: 'respondUserInfo',
  consumes: ['userInfoResponse'],
  produces: [],
  removable: false,
});

/**
 * Send a UserInfo answer.
 * RFC 6750 Section 5.2 / OIDC Core 1.0 Section 16.4: UserInfo responses
 * (success and error) expose PII and must not be cached by intermediaries.
 */
export function respondUserInfo(c: any, response: UserInfoEndpointResponse): Response {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    c.header(name, value);
  }
  if (response.text !== undefined) {
    return c.body(response.text, response.status);
  }
  return c.json(response.body ?? {}, response.status);
}
