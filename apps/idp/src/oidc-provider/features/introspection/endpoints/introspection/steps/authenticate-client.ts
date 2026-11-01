import {
  extractClientCredentials,
  resolveAuthenticatedTokenClient,
  validateClientAuthMethod,
  verifyClientSecret,
  requireConfidentialIntrospectionCaller,
} from '@maronn-openid-connect/core';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'authenticate-client',
  endpoint: 'introspection',
  feature: 'introspection',
  kind: 'validate',
  label: 'Authenticate the confidential client',
  spec: 'RFC 7662 §2.1 / OAuth 2.1 §2.3',
  function: 'authenticateIntrospectionClient',
  calls: ['extractClientCredentials', 'resolveAuthenticatedTokenClient', 'validateClientAuthMethod', 'verifyClientSecret', 'requireConfidentialIntrospectionCaller'],
  consumes: ['params', 'authorization'],
  produces: ['authenticatedClientId'],
  removable: false,
});

/**
 * Authenticate the caller — the same steps as the token endpoint
 * (OAuth 2.1 §2.3 / OIDC Core 1.0 §9) — and require a confidential client.
 * RFC 7662 §2.1 / RFC 9701 §5
 *
 * A client registered with token_endpoint_auth_method 'none' passes the
 * pipeline by presenting its client_id alone — public information — so
 * treating it as authenticated would let anyone scan tokens. Revocation
 * deliberately has no such step: RFC 7009 §2.1 lets a public client revoke
 * its own tokens.
 */
export async function authenticateIntrospectionClient(
  c: any,
  params: Record<string, string>,
  authorization: string,
): Promise<string> {
  const tokenClientResolver = c.get('tokenClientResolver');
  const presentedCredentials = extractClientCredentials({
    params,
    authorizationHeader: authorization,
  });
  const introspectingClient = await resolveAuthenticatedTokenClient(
    presentedCredentials.clientId,
    tokenClientResolver,
  );
  validateClientAuthMethod(introspectingClient, presentedCredentials);
  await verifyClientSecret(introspectingClient, presentedCredentials.clientSecret);
  requireConfidentialIntrospectionCaller(introspectingClient);
  return presentedCredentials.clientId;
}
