import type { JwkSet } from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'respond',
  endpoint: 'jwks',
  kind: 'respond',
  label: 'Respond with the cacheable JWK Set',
  function: 'respondJwks',
  consumes: ['jwks'],
  produces: [],
  removable: false,
});

/** Respond with the cacheable JWK Set (3600s, symmetric with discovery). */
export function respondJwks(c: any, jwks: JwkSet): Response {
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json(jwks);
}
