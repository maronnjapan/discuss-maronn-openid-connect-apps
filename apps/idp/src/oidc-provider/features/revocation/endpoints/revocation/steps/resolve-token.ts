import {
  requireRevocationToken,
  requireRevocationClient,
  resolveRevocationTarget,
  type ResolvedRevocationToken,
} from '@maronn-openid-connect/core';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'resolve-token',
  endpoint: 'revocation',
  feature: 'revocation',
  kind: 'resolve',
  label: 'Resolve the presented token',
  spec: 'RFC 7009 §2.1',
  function: 'resolveRevocationTokenTarget',
  calls: ['requireRevocationToken', 'requireRevocationClient', 'resolveRevocationTarget'],
  consumes: ['params', 'authenticatedClientId'],
  produces: ['token', 'resolved'],
  removable: false,
});

/**
 * Resolve the presented token (access or refresh token); null when unknown.
 * RFC 7009 §2.1
 *
 * Each check is an independent core function. token_type_hint only reorders
 * the lookup — the other token type is still searched when the hint misses.
 */
export async function resolveRevocationTokenTarget(
  c: any,
  params: Record<string, string>,
  authenticatedClientId: string,
): Promise<{ token: string; resolved: ResolvedRevocationToken | null }> {
  const resolvers = c.get('revocationResolvers');

  // RFC 7009 §2.1: token is REQUIRED (invalid_request when absent).
  const token = requireRevocationToken({
    token: typeof params.token === 'string' ? params.token : undefined,
  });

  // RFC 7009 §2.1: the caller must be an identified client (invalid_client).
  requireRevocationClient(authenticatedClientId);

  const resolved = await resolveRevocationTarget({
    token,
    tokenTypeHint:
      typeof params.token_type_hint === 'string' ? params.token_type_hint : undefined,
    resolvers,
  });
  return { token, resolved };
}
