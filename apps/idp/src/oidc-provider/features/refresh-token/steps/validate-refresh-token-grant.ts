import {
  type TokenRequestParams,
  resolveRefreshToken,
  validateRefreshTokenUnused,
  validateRefreshTokenClient,
  validateRefreshTokenExpiration,
  validateRefreshTokenIdleTimeout,
  validateRefreshTokenSession,
  validateRefreshTokenScope,
  buildValidatedRefreshTokenRequest,
  type ValidatedRefreshTokenRequest,
} from '@maronn-openid-connect/core';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'validate-refresh-token-grant',
  endpoint: 'token',
  feature: 'refresh-token',
  kind: 'validate',
  label: 'Validate the refresh_token grant',
  spec: 'OAuth 2.1 §4.3.1 / RFC 6749 §6',
  function: 'validateRefreshTokenGrant',
  calls: ['resolveRefreshToken', 'validateRefreshTokenUnused', 'validateRefreshTokenClient', 'validateRefreshTokenExpiration', 'validateRefreshTokenIdleTimeout', 'validateRefreshTokenSession', 'validateRefreshTokenScope', 'buildValidatedRefreshTokenRequest'],
  consumes: ['params', 'authenticatedClientId', 'grantType'],
  produces: ['refreshTokenRequest'],
  removable: false,
});

/**
 * Validate the refresh_token grant. Returns undefined for any other grant,
 * which the validate-authorization-code-grant step validates.
 * OAuth 2.1 §4.3.1 / RFC 6749 §6
 *
 * Each security rule is a separate core call so it can be removed, replaced,
 * or surrounded with experiment-specific logic.
 */
export async function validateRefreshTokenGrant(
  c: any,
  params: TokenRequestParams,
  authenticatedClientId: string,
  grantType: string,
): Promise<ValidatedRefreshTokenRequest | undefined> {
  if (grantType !== 'refresh_token') return undefined;
  const refreshTokenResolver = c.get('refreshTokenResolver');
  // online refresh token の束縛先セッションを sessionId から引く。差し替えると
  // 「セッションが生きているか」の判定そのものを差し替えられる。
  const authenticationSessionResolver = c.get('authenticationSessionResolver');

  // Resolve the presented refresh token and retain its stored grant context.
  const { refreshTokenInfo } = await resolveRefreshToken(
    params,
    refreshTokenResolver,
  );

  // OAuth 2.1 §4.3.1: reject rotation reuse and revoke the token family.
  await validateRefreshTokenUnused(refreshTokenInfo, refreshTokenResolver);

  // Bind the refresh token to the authenticated client.
  validateRefreshTokenClient(refreshTokenInfo, authenticatedClientId);

  // Absolute lifetime: expiresAt <= now is expired.
  validateRefreshTokenExpiration(refreshTokenInfo);

  // Optional inactivity policy. Replace undefined with your timeout in seconds
  // to enable it, or remove this step if your experiment has no idle lifetime.
  validateRefreshTokenIdleTimeout(refreshTokenInfo, undefined);

  // online refresh token（sessionId を持つ RT）は、束縛先のログインセッションが
  // 生きている間だけ使える。ログアウト・別ユーザーでの再ログインでセッションが
  // 消えれば invalid_grant になる。offline_access が付与された RT は sessionId を
  // 持たないため、このステップを素通りしてログアウト後も使い続けられる。
  await validateRefreshTokenSession(refreshTokenInfo, authenticationSessionResolver);

  // RFC 6749 §6: requested scope may only narrow the original grant.
  const effectiveScope = validateRefreshTokenScope(
    params.scope,
    refreshTokenInfo.scope,
  );

  return buildValidatedRefreshTokenRequest(
    refreshTokenInfo,
    authenticatedClientId,
    effectiveScope,
  );
}
