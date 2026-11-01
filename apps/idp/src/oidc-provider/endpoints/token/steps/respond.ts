import type { TokenEndpointResponse } from '../response.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'respond',
  endpoint: 'token',
  kind: 'respond',
  label: 'Respond (no-store)',
  spec: 'RFC 6749 §5.1',
  function: 'respondToken',
  consumes: ['tokenResponse'],
  produces: [],
  removable: false,
});

/**
 * Send a token endpoint answer.
 * RFC 6749 §5.1 / §5.2: token responses and error responses MUST NOT be cached.
 */
export function respondToken(c: any, response: TokenEndpointResponse): Response {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    c.header(name, value);
  }
  return c.json(response.body, response.status);
}
