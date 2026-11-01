import type { ValidatedTokenRequest } from '@maronn-openid-connect/core';
import type { TokenEndpointResponse } from '../response.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'build-token-response',
  endpoint: 'token',
  kind: 'transform',
  label: 'Build the token response body',
  spec: 'OIDC Core 1.0 §3.1.3.3 / RFC 6749 §5.1',
  function: 'buildTokenResponse',
  consumes: ['accessToken', 'idToken', 'refreshToken', 'validatedRequest'],
  optional: ['refreshToken'],
  produces: ['tokenResponse'],
  removable: false,
});

/**
 * Build the token response body.
 * OIDC Core 1.0 §3.1.3.3 / RFC 6749 §5.1
 */
export function buildTokenResponse(
  c: any,
  input: {
    accessToken: string;
    idToken: string | undefined;
    refreshToken?: string;
    validatedRequest: ValidatedTokenRequest;
  },
): TokenEndpointResponse {
  const { accessToken, idToken, refreshToken, validatedRequest } = input;
  const config = c.get('config');
  return {
    status: 200,
    body: {
      access_token: accessToken,
      token_type: 'Bearer' as const,
      expires_in: config.accessTokenExpiresIn,
      id_token: idToken,
      scope: validatedRequest.scope.join(' '),
      refresh_token: refreshToken,
    },
  };
}
