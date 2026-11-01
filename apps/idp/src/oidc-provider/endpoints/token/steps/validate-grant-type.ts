import {
  type TokenRequestParams,
  type TokenClientInfo,
  validateGrantTypeSupported,
  validateClientGrantType,
} from '@maronn-openid-connect/core';
import { features } from '../../../features/enabled.js';
import { tokenGrantsOf } from '../../../features/feature.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'validate-grant-type',
  endpoint: 'token',
  kind: 'validate',
  label: 'Validate grant_type',
  spec: 'RFC 6749 §5.2',
  function: 'validateTokenGrantType',
  calls: ['validateGrantTypeSupported', 'validateClientGrantType'],
  consumes: ['params', 'tokenClient'],
  produces: ['grantType'],
  removable: false,
});

/**
 * Validate grant_type: offered by this OP, and allowed for this client.
 * RFC 6749 §5.2 (unsupported_grant_type / unauthorized_client)
 */
export function validateTokenGrantType(
  params: TokenRequestParams,
  tokenClient: TokenClientInfo,
): 'authorization_code' | 'refresh_token' {
  // RFC 6749 §5.2: is the grant_type offered by this OP at all? The
  // authorization_code grant always is; refresh_token only when the
  // refresh-token feature answers it (the token entry of its feature.ts). The
  // grants a feature answers itself were dispatched before this step.
  const grantType = validateGrantTypeSupported(params.grant_type, [
    'authorization_code',
    ...tokenGrantsOf(features),
  ]);

  // RFC 6749 §5.2: per-client grant_type authorization (unauthorized_client).
  validateClientGrantType(tokenClient, grantType);

  return grantType;
}
