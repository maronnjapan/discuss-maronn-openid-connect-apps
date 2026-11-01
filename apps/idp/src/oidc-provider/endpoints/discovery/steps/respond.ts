import { step } from '../../step.js';

export const meta = step({
  id: 'respond',
  endpoint: 'discovery',
  kind: 'respond',
  label: 'Respond with the cacheable JSON document',
  spec: 'RFC 8414 §3.2',
  function: 'respondDiscovery',
  consumes: ['metadata'],
  produces: [],
  removable: false,
});

/**
 * RFC 8414 §3.2 / RFC 9111 §5.2: Discovery metadata is cacheable. Advertise a
 * 3600s freshness lifetime, symmetric with the JWKS endpoint, so client
 * libraries reuse the metadata deterministically.
 */
export function respondDiscovery(c: any, metadata: Record<string, unknown>): Response {
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json(metadata);
}
