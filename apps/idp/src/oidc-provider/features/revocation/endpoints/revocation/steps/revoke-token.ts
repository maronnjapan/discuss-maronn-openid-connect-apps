import {
  type ResolvedRevocationToken,
  validateRevocationTokenClient,
  revokeResolvedToken,
  revokeGrantAccessTokens,
} from '@maronn-openid-connect/core';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'revoke-token',
  endpoint: 'revocation',
  feature: 'revocation',
  kind: 'persist',
  label: 'Revoke the token and its grant siblings',
  spec: 'RFC 7009 §2.1',
  function: 'revokeToken',
  calls: ['validateRevocationTokenClient', 'revokeResolvedToken', 'revokeGrantAccessTokens'],
  consumes: ['token', 'resolved', 'authenticatedClientId'],
  produces: [],
  removable: false,
});

/**
 * Revoke the token, and the access tokens of its grant when it is a refresh
 * token (RFC 7009 §2.1 SHOULD). RFC 7009 §2.2: an unknown token is still a
 * success, so the client cannot probe which token values exist.
 */
export async function revokeToken(
  c: any,
  token: string,
  resolved: ResolvedRevocationToken | null,
  authenticatedClientId: string,
): Promise<void> {
  if (resolved === null) return;
  const resolvers = c.get('revocationResolvers');

  // RFC 7009 §2.1: a token issued to another client is refused (invalid_grant).
  validateRevocationTokenClient(resolved, authenticatedClientId);

  await revokeResolvedToken(token, resolved, resolvers);

  // RFC 7009 §2.1 SHOULD: revoking a refresh token also revokes the access
  // tokens of the same grant. Delete this call to revoke only the presented
  // token.
  await revokeGrantAccessTokens(resolved, resolvers);
}
