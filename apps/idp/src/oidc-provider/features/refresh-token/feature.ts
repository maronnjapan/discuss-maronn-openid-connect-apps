import { defineFeature } from '../feature.js';

/**
 * Refresh tokens (OAuth 2.1 §4.3 / §6, OIDC Core 1.0 §11 / §12).
 *
 * The token endpoint accepts the refresh_token grant, and issues, rotates and
 * revokes refresh tokens in the blocks of endpoints/token/pipeline.ts that
 * name this feature. offline_access is advertised, and the authorization
 * endpoint grants it (with prompt=consent) only because this feature answers
 * the refresh_token grant. Without the feature the grant is rejected with
 * unsupported_grant_type and offline_access is never granted.
 */
export const refreshToken = defineFeature({
  id: 'refresh-token',
  token: { grants: ['refresh_token'] },
  // OIDC Core 1.0 §11: offline_access is advertised so relying parties (and the
  // OIDF Conformance Suite's oidcc-refresh-token module) know they may request
  // refresh tokens via 'scope=openid offline_access' with prompt=consent.
  // It is a refresh-token request scope, not a claim scope, so no matching
  // entry is added to claims_supported.
  discovery: () => ({ scopes_supported: ['offline_access'] }),
});
