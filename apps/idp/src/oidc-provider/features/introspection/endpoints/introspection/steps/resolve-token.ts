import {
  requireIntrospectionToken,
  requireIntrospectionClient,
  resolveIntrospectionToken,
  type ResolvedIntrospectionToken,
} from '@maronn-openid-connect/core';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'resolve-token',
  endpoint: 'introspection',
  feature: 'introspection',
  kind: 'resolve',
  label: 'Resolve the presented token',
  spec: 'RFC 7662 §2.1',
  function: 'resolveIntrospectedToken',
  calls: ['requireIntrospectionToken', 'requireIntrospectionClient', 'resolveIntrospectionToken'],
  consumes: ['params', 'authenticatedClientId'],
  produces: ['resolved'],
  removable: false,
});

/**
 * Resolve the presented token (access or refresh token); null when unknown.
 * RFC 7662 §2.1
 *
 * Each check is an independent core function. token_type_hint only reorders
 * the lookup — the other token type is still searched when the hint misses.
 */
export async function resolveIntrospectedToken(
  c: any,
  params: Record<string, string>,
  authenticatedClientId: string,
): Promise<ResolvedIntrospectionToken | null> {
  const accessTokenResolver = c.get('introspectionAccessTokenResolver');
  const refreshTokenResolver = c.get('introspectionRefreshTokenResolver');

  // RFC 7662 §2.1: token is REQUIRED (invalid_request when absent).
  const token = requireIntrospectionToken({
    token: typeof params.token === 'string' ? params.token : undefined,
  });

  // RFC 7662 §2.1: the caller must be an authenticated client (invalid_client).
  requireIntrospectionClient(authenticatedClientId);

  return resolveIntrospectionToken({
    token,
    tokenTypeHint:
      typeof params.token_type_hint === 'string' ? params.token_type_hint : undefined,
    accessTokenResolver,
    refreshTokenResolver,
  });
}
