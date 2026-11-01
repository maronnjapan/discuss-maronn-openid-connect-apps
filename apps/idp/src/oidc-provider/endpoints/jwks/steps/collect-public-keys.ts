import type { SigningKey } from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'collect-public-keys',
  endpoint: 'jwks',
  kind: 'resolve',
  label: 'Collect every registered signing key',
  function: 'collectPublishedKeys',
  consumes: [],
  produces: ['keys'],
  removable: false,
});

/**
 * Collect every registered signing key of the per-purpose key sets
 * (signingKeys / idTokenSigningKeys / userinfoSigningKeys).
 *
 * T-022: every key is published so rotated-out keys remain verifiable until
 * tokens signed with them expire.
 */
export function collectPublishedKeys(c: any): SigningKey[] {
  return [
    ...((c.get('signingKeys') as SigningKey[] | undefined) ?? []),
    ...((c.get('idTokenSigningKeys') as SigningKey[] | undefined) ?? []),
    ...((c.get('userinfoSigningKeys') as SigningKey[] | undefined) ?? []),
  ];
}
