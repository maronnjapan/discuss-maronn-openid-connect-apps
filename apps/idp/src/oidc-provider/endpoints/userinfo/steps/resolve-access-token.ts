import {
  resolveUserInfoAccessToken,
  validateUserInfoTokenExpiration,
  validateUserInfoScope,
  validateUserInfoAudience,
  type AccessTokenInfo,
} from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'resolve-access-token',
  endpoint: 'userinfo',
  kind: 'resolve',
  label: 'Resolve and validate the access token',
  spec: 'OIDC Core 1.0 §5.3.1 / RFC 6750 §3.1 / RFC 9068 §4',
  function: 'resolveUserInfoToken',
  calls: ['resolveUserInfoAccessToken', 'validateUserInfoTokenExpiration', 'validateUserInfoScope', 'validateUserInfoAudience'],
  consumes: ['accessToken'],
  produces: ['tokenInfo'],
  removable: false,
});

/**
 * Resolve the presented Bearer token and validate it: known, not expired,
 * carries the openid scope, and names this UserInfo endpoint in its audience.
 * OIDC Core 1.0 §5.3.1 / RFC 6750 §3.1 / RFC 9068 §4
 *
 * Each check is an independent core function that throws UserInfoError, which
 * respondUserInfoError() renders as an RFC 6750 Bearer challenge.
 */
export async function resolveUserInfoToken(c: any, accessToken: string): Promise<AccessTokenInfo> {
  const accessTokenResolver = c.get('accessTokenResolver');

  // OIDC Core 1.0 §5.3.1: resolve the presented Bearer token (invalid_token when unknown).
  const tokenInfo = await resolveUserInfoAccessToken(accessToken, accessTokenResolver);

  // RFC 6750 §3.1: an expired access token is invalid_token.
  validateUserInfoTokenExpiration(tokenInfo);

  // OIDC Core 1.0 §5.3.1: the token must carry the openid scope (insufficient_scope).
  validateUserInfoScope(tokenInfo);

  // RFC 9068 §4: this UserInfo endpoint must appear in the access token's aud.
  // The token endpoint always stores the UserInfo endpoint URL in aud
  // (buildAccessTokenAudience), so audience validation is on by default for
  // both JWT and opaque tokens. Pass undefined to turn it off.
  validateUserInfoAudience(tokenInfo, `${c.get('config').issuer}/userinfo`);

  return tokenInfo;
}
