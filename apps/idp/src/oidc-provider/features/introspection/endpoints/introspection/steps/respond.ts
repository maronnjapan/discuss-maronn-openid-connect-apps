import type { IntrospectionEndpointResponse } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'respond',
  endpoint: 'introspection',
  feature: 'introspection',
  kind: 'respond',
  label: 'Respond (no-store)',
  spec: 'RFC 7662 §2.2',
  function: 'respondIntrospection',
  consumes: ['introspection'],
  produces: [],
  removable: false,
});

/**
 * Send an introspection answer. RFC 7662 Section 2.2: never cached.
 */
export function respondIntrospection(c: any, response: IntrospectionEndpointResponse): Response {
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
