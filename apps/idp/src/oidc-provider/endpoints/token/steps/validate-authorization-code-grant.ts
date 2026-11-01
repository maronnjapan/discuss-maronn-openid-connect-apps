import {
  type TokenRequestParams,
  resolveAuthorizationCode,
  validateAuthorizationCodeUnused,
  validateAuthorizationCodeClient,
  validateAuthorizationCodeExpiration,
  validateAuthorizationCodeRedirectUri,
  verifyAuthorizationCodePkce,
  consumeAuthorizationCode,
  buildValidatedAuthorizationCodeRequest,
  type ValidatedAuthorizationCodeRequest,
} from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'validate-authorization-code-grant',
  endpoint: 'token',
  kind: 'validate',
  label: 'Validate the authorization_code grant',
  spec: 'OAuth 2.1 §4.1.2 / RFC 7636 / OIDC Core 1.0 §3.1.3.2',
  function: 'validateAuthorizationCodeGrant',
  calls: ['resolveAuthorizationCode', 'validateAuthorizationCodeUnused', 'validateAuthorizationCodeClient', 'validateAuthorizationCodeExpiration', 'validateAuthorizationCodeRedirectUri', 'verifyAuthorizationCodePkce', 'consumeAuthorizationCode', 'buildValidatedAuthorizationCodeRequest'],
  consumes: ['params', 'authenticatedClientId', 'grantType', 'refreshTokenRequest'],
  optional: ['refreshTokenRequest'],
  produces: ['validatedRequest'],
  removable: false,
});

/**
 * Validate the authorization_code grant.
 * OAuth 2.1 §4.1.2 / RFC 7636 / OIDC Core 1.0 §3.1.3.2
 *
 * Each security rule is a separate core call so it can be removed, replaced,
 * or surrounded with experiment-specific logic.
 */
export async function validateAuthorizationCodeGrant(
  c: any,
  params: TokenRequestParams,
  authenticatedClientId: string,
): Promise<ValidatedAuthorizationCodeRequest> {
  const authorizationCodeResolver = c.get('authCodeResolver');

  // Resolve the presented authorization code and retain the non-optional code.
  const { code, authorizationCode } = await resolveAuthorizationCode(
    params,
    authorizationCodeResolver,
  );

  // OAuth 2.1 §4.1.2: reject reuse and revoke tokens from the compromised grant.
  await validateAuthorizationCodeUnused(
    authorizationCode,
    authorizationCodeResolver,
  );

  // Bind the authorization code to the authenticated client and its lifetime.
  validateAuthorizationCodeClient(authorizationCode, authenticatedClientId);
  validateAuthorizationCodeExpiration(authorizationCode);

  // OIDC Core 1.0 §3.1.3.2: bind the token request redirect_uri.
  validateAuthorizationCodeRedirectUri(
    authorizationCode,
    params.redirect_uri,
  );

  // RFC 7636: validate the S256 verifier when the code carries a PKCE binding.
  const codeVerified = await verifyAuthorizationCodePkce(
    authorizationCode,
    params.code_verifier,
  );

  // Mark used (do not physically delete) so a later replay remains detectable.
  await consumeAuthorizationCode(code, authorizationCodeResolver);

  return buildValidatedAuthorizationCodeRequest(
    code,
    authorizationCode,
    authenticatedClientId,
    codeVerified,
  );
}
