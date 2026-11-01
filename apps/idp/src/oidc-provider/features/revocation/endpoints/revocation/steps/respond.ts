import { noStore } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'respond',
  endpoint: 'revocation',
  feature: 'revocation',
  kind: 'respond',
  label: 'Respond 200 with an empty body',
  spec: 'RFC 7009 §2.2',
  function: 'respondRevocation',
  consumes: [],
  produces: [],
  removable: false,
});

/**
 * RFC 7009 Section 2.2: empty body, 200 OK — for "revoked" and "not found" alike.
 */
export function respondRevocation(c: any): Response {
  noStore(c);
  return c.body(null, 200);
}
