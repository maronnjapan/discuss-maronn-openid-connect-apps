import {
  type AccessTokenInfo,
  resolveUserInfoClaims,
  filterClaimsByScope,
  applyRequestedClaims,
  type UserInfoResponse,
} from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'resolve-claims',
  endpoint: 'userinfo',
  kind: 'resolve',
  label: 'Resolve the claims the token may see',
  spec: 'OIDC Core 1.0 §5.4 / §5.5',
  function: 'resolveUserInfoResponseClaims',
  calls: ['resolveUserInfoClaims', 'filterClaimsByScope', 'applyRequestedClaims'],
  consumes: ['tokenInfo'],
  produces: ['claims'],
  removable: false,
});

/**
 * Resolve the claims the token may see: every claim the OP knows about the
 * subject, narrowed to the granted scopes, plus the individually requested
 * claims stored with the token. OIDC Core 1.0 §5.4 / §5.5
 */
export async function resolveUserInfoResponseClaims(
  c: any,
  tokenInfo: AccessTokenInfo,
): Promise<UserInfoResponse> {
  const userClaimsResolver = c.get('userClaimsResolver');

  // Load every claim the OP knows about the token's subject.
  const userClaims = await resolveUserInfoClaims(tokenInfo, userClaimsResolver);

  // OIDC Core 1.0 §5.4: keep only the claims the granted scopes allow.
  const scopedResponse = filterClaimsByScope(userClaims, tokenInfo.scope);

  // OIDC Core 1.0 §5.5: overlay the individually requested claims that the
  // token endpoint stored with this access token (claims.userinfo members).
  return applyRequestedClaims(scopedResponse, userClaims, tokenInfo.claims);
}
