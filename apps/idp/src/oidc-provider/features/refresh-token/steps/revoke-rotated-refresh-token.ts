import type { TokenRequestParams, ValidatedTokenRequest } from '@maronn-openid-connect/core';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'revoke-rotated-refresh-token',
  endpoint: 'token',
  feature: 'refresh-token',
  kind: 'persist',
  label: 'Revoke the presented refresh token (rotation)',
  spec: 'OAuth 2.1 §4.3.1',
  function: 'revokeRotatedRefreshToken',
  consumes: ['params', 'validatedRequest'],
  produces: [],
  removable: true,
  after: ['issue-refresh-token'],
});

/**
 * Rotation: revoke the refresh token the request presented, now that its
 * successor is stored. Always this order, so a failure never leaves the
 * End-User without a refresh token.
 * OAuth 2.1 §4.3.1
 */
export async function revokeRotatedRefreshToken(
  c: any,
  params: TokenRequestParams,
  validatedRequest: ValidatedTokenRequest,
): Promise<void> {
  if (validatedRequest.grantType !== 'refresh_token' || !params.refresh_token) return;
  const refreshTokenResolver = c.get('refreshTokenResolver');
  await refreshTokenResolver.revokeRefreshToken(params.refresh_token);
}
