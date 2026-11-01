import {
  extractClientCredentials,
  resolveAuthenticatedTokenClient,
  validateClientAuthMethod,
  verifyClientSecret,
  type TokenClientInfo,
} from '@maronn-openid-connect/core';
import type { TokenRequestBody } from '../response.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'authenticate-client',
  endpoint: 'token',
  kind: 'validate',
  label: 'Authenticate the client',
  spec: 'OAuth 2.1 §2.3 / OIDC Core 1.0 §9',
  function: 'authenticateTokenClient',
  calls: ['extractClientCredentials', 'resolveAuthenticatedTokenClient', 'validateClientAuthMethod', 'verifyClientSecret'],
  consumes: ['params', 'authorization'],
  produces: ['tokenClient', 'authenticatedClientId'],
  removable: false,
});

/**
 * Authenticate the client.
 * OAuth 2.1 §2.3 / OIDC Core 1.0 §9: client_secret_basic / client_secret_post.
 *
 * Each step inside is an independent core function. Replace verifyClientSecret
 * with your own assertion check (e.g. private_key_jwt) without touching the rest.
 */
export async function authenticateTokenClient(
  c: any,
  params: TokenRequestBody,
  authorization: string,
): Promise<{ tokenClient: TokenClientInfo; authenticatedClientId: string }> {
  const tokenClientResolver = c.get('tokenClientResolver');

  // Read the presented credentials and which method was actually used.
  const presentedCredentials = extractClientCredentials({
    params,
    authorizationHeader: authorization,
  });

  // RFC 6749 §5.2: the presented client_id must resolve to a registered client.
  const tokenClient = await resolveAuthenticatedTokenClient(
    presentedCredentials.clientId,
    tokenClientResolver,
  );

  // OIDC Core 1.0 §9: the method used must be one the client registered
  // (blocks auth method downgrade / public-client mixups).
  validateClientAuthMethod(tokenClient, presentedCredentials);

  // OAuth 2.1 §7.4.1: constant-time client_secret comparison.
  await verifyClientSecret(tokenClient, presentedCredentials.clientSecret);

  return { tokenClient, authenticatedClientId: presentedCredentials.clientId };
}
