import {
  type ValidatedTokenRequest,
  TokenError,
  TokenErrorCode,
} from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'resolve-subject',
  endpoint: 'token',
  kind: 'resolve',
  label: 'Resolve the subject, auth_time and nonce',
  spec: 'OIDC Core 1.0 §12.2',
  function: 'resolveTokenSubject',
  consumes: ['validatedRequest'],
  produces: ['subject', 'authTime', 'nonce'],
  removable: false,
});

/**
 * Resolve the subject, auth_time and nonce the tokens are issued for: from the
 * authorization code record (authorization_code), or from the refresh token's
 * stored grant (refresh_token).
 * OIDC Core 1.0 §12.2
 */
export async function resolveTokenSubject(
  c: any,
  validatedRequest: ValidatedTokenRequest,
): Promise<{ subject: string; authTime: number | undefined; nonce: string | undefined }> {
  if (validatedRequest.grantType === 'authorization_code') {
    const authCodeStore = c.get('authCodeStore');
    const authCode = await authCodeStore.get(validatedRequest.code);
    if (!authCode?.subject || !authCode.authTime) {
      throw new TokenError(
        TokenErrorCode.InvalidGrant,
        'Authorization code missing required subject context',
      );
    }
    return { subject: authCode.subject, authTime: authCode.authTime, nonce: validatedRequest.nonce };
  }
  // refresh_token grant
  // OIDC Core 1.0 §12.2: the re-issued ID Token retains iss/sub/aud/exp/iat/
  // auth_time/azp/acr/amr — nonce is NOT in that list. nonce binds an
  // Authentication Request to its ID Token (§2); a refresh has no such request,
  // so carrying the old nonce adds no replay protection. Major OPs (Google,
  // Auth0) omit it on refresh, so we omit it here by default. auth_time is
  // still preserved per §12.1.
  return { subject: validatedRequest.subject, authTime: validatedRequest.authTime, nonce: undefined };
}
