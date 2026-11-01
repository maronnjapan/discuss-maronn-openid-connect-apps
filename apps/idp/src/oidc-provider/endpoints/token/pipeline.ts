import { Hono } from 'hono';
import { decideRefreshTokenIssuance } from '../../features/refresh-token/steps/decide-refresh-token-issuance.js';
import { issueRefreshToken } from '../../features/refresh-token/steps/issue-refresh-token.js';
import { revokeRotatedRefreshToken } from '../../features/refresh-token/steps/revoke-rotated-refresh-token.js';
import { validateRefreshTokenGrant } from '../../features/refresh-token/steps/validate-refresh-token-grant.js';
import { authenticateTokenClient } from './steps/authenticate-client.js';
import { buildTokenResponse } from './steps/build-token-response.js';
import { issueAccessToken } from './steps/issue-access-token.js';
import { issueIdToken } from './steps/issue-id-token.js';
import { parseTokenRequest } from './steps/parse-request.js';
import { persistAccessToken } from './steps/persist-access-token.js';
import { resolveTokenAcrAmr } from './steps/resolve-acr-amr.js';
import { resolveTokenSubject } from './steps/resolve-subject.js';
import { respondTokenError } from './steps/respond-error.js';
import { respondToken } from './steps/respond.js';
import { selectTokenSigningKeys } from './steps/select-signing-keys.js';
import { validateAuthorizationCodeGrant } from './steps/validate-authorization-code-grant.js';
import { validateTokenGrantType } from './steps/validate-grant-type.js';

/**
 * Token endpoint (API layer).
 * OIDC Core 1.0 Section 3.1.3 / RFC 6749 Section 4.1.3
 *
 * Each block below calls one step (one box of
 * `maronn-oidc graph --detail steps --endpoint token`): parse the request,
 * authenticate the client, dispatch the grants a feature answers, validate
 * the grant, select the keys, resolve the subject, issue and store the
 * tokens, and answer. Delete a block to drop that step, or insert your own
 * logic between two blocks. A block whose marker names a feature belongs to
 * that feature, and its step is in features/<id>/. A step that throws ends in
 * respondTokenError().
 */
export const tokenApp = new Hono<{ Variables: Record<string, any> }>();

tokenApp.post('/', async (c) => {
  try {
    // [parse-request] Parse the token request — RFC 6749 §4.1.3 / §3.2
    const { params, authorization } = await parseTokenRequest(c);

    // [authenticate-client] Authenticate the client — OAuth 2.1 §2.3 / OIDC Core 1.0 §9
    const { tokenClient, authenticatedClientId } = await authenticateTokenClient(c, params, authorization);

    // [validate-grant-type] Validate grant_type — RFC 6749 §5.2
    const grantType = validateTokenGrantType(params, tokenClient);

    // [validate-refresh-token-grant] (feature: refresh-token) Validate the refresh_token grant — OAuth 2.1 §4.3.1 / RFC 6749 §6
    const refreshTokenRequest = await validateRefreshTokenGrant(c, params, authenticatedClientId, grantType);

    // [validate-authorization-code-grant] Validate the authorization_code grant — OAuth 2.1 §4.1.2 / RFC 7636 / OIDC Core 1.0 §3.1.3.2
    const validatedRequest =
      refreshTokenRequest ?? (await validateAuthorizationCodeGrant(c, params, authenticatedClientId));

    // [select-signing-keys] Select the signing keys — OIDC Dynamic Client Registration 1.0 §2 (id_token_signed_response_alg)
    const { signingKey, idTokenSigningKey } = await selectTokenSigningKeys(c, authenticatedClientId);

    // [resolve-subject] Resolve the subject, auth_time and nonce — OIDC Core 1.0 §12.2
    const { subject, authTime, nonce } = await resolveTokenSubject(c, validatedRequest);

    // [decide-refresh-token-issuance] (feature: refresh-token) Decide whether a refresh token is issued — OIDC Core 1.0 §11 / RFC 9700 §4.14
    const refreshTokenDecision = decideRefreshTokenIssuance(c, tokenClient, validatedRequest);

    // [resolve-acr-amr] Resolve the acr / amr the tokens carry — OIDC Core 1.0 §3.1.2.1 / §12.1 / RFC 9068 §2.2.1
    const { acr, amr } = await resolveTokenAcrAmr(c, { subject, validatedRequest });

    // [issue-access-token] Issue the access token — RFC 9068 §2.2 / §2.2.1 / §3
    // One timestamp for the whole response so the issued tokens and the stored
    // token metadata agree on iat / exp.
    const issuedAt = Math.floor(Date.now() / 1000);
    const { accessToken, accessTokenPayload, audience } = await issueAccessToken(c, { signingKey, subject, validatedRequest, issuedAt, acr });

    // [issue-id-token] Issue the ID Token — OIDC Core 1.0 §3.1.3.6 / §12.1
    const idToken = await issueIdToken(c, { idTokenSigningKey, accessToken, subject, authTime, nonce, validatedRequest, issuedAt, acr, amr });

    // [persist-access-token] Store the access token record — RFC 7662 §2.2 / OIDC Core 1.0 §5.5 / RFC 9470 §6.2
    await persistAccessToken(c, { accessToken, accessTokenPayload, subject, validatedRequest, issuedAt, audience, acr });

    // [issue-refresh-token] (feature: refresh-token) Mint and store the refresh token — OAuth 2.1 §4.3.1 / §6.1
    const refreshToken = await issueRefreshToken(c, {
      decision: refreshTokenDecision,
      subject,
      authTime,
      nonce,
      validatedRequest,
      issuedAt,
      audience,
      acr,
      amr,
    });

    // [revoke-rotated-refresh-token] (feature: refresh-token) Revoke the presented refresh token (rotation) — OAuth 2.1 §4.3.1
    await revokeRotatedRefreshToken(c, params, validatedRequest);

    // [build-token-response] Build the token response body — OIDC Core 1.0 §3.1.3.3 / RFC 6749 §5.1
    const tokenResponse = buildTokenResponse(c, { accessToken, idToken, refreshToken, validatedRequest });

    // [respond] Respond (no-store) — RFC 6749 §5.1
    return respondToken(c, tokenResponse);
  } catch (error) {
    return respondTokenError(c, error);
  }
});
