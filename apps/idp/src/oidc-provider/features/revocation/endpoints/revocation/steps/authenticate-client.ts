import {
  extractClientCredentials,
  resolveAuthenticatedTokenClient,
  validateClientAuthMethod,
  verifyClientSecret,
} from '@maronn-openid-connect/core';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'authenticate-client',
  endpoint: 'revocation',
  feature: 'revocation',
  kind: 'validate',
  label: 'Authenticate the client',
  spec: 'RFC 7009 §2.1 / OAuth 2.1 §2.3',
  function: 'authenticateRevocationClient',
  calls: ['extractClientCredentials', 'resolveAuthenticatedTokenClient', 'validateClientAuthMethod', 'verifyClientSecret'],
  consumes: ['params', 'authorization'],
  produces: ['authenticatedClientId'],
  removable: false,
});

/**
 * Authenticate the caller — the same steps as the token endpoint
 * (OAuth 2.1 §2.3 / OIDC Core 1.0 §9). Public clients registered with
 * token_endpoint_auth_method=none pass with client_id only (RFC 7009 §2.1).
 */
export async function authenticateRevocationClient(
  c: any,
  params: Record<string, string>,
  authorization: string,
): Promise<string> {
  const tokenClientResolver = c.get('tokenClientResolver');
  const presentedCredentials = extractClientCredentials({
    params,
    authorizationHeader: authorization,
  });
  const revokingClient = await resolveAuthenticatedTokenClient(
    presentedCredentials.clientId,
    tokenClientResolver,
  );
  validateClientAuthMethod(revokingClient, presentedCredentials);
  await verifyClientSecret(revokingClient, presentedCredentials.clientSecret);
  return presentedCredentials.clientId;
}
