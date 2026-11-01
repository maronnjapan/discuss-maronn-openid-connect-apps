import type { ValidatedTokenRequest } from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'persist-access-token',
  endpoint: 'token',
  kind: 'persist',
  label: 'Store the access token record',
  spec: 'RFC 7662 §2.2 / OIDC Core 1.0 §5.5 / RFC 9470 §6.2',
  function: 'persistAccessToken',
  consumes: ['accessToken', 'accessTokenPayload', 'subject', 'validatedRequest', 'issuedAt', 'audience', 'acr'],
  produces: [],
  removable: false,
});

/**
 * Store the access token record for the UserInfo, introspection and
 * revocation endpoints.
 * RFC 7662 §2.2 / RFC 9068 §2.2 / OIDC Core 1.0 §5.5 / RFC 9470 §6.2
 *
 * iat / nbf / audience / issuer / acr are kept so introspection can echo
 * them. grantId binds this token to the original authorization grant so it can
 * be revoked together with sibling tokens on code reuse (OAuth 2.1 §4.1.2).
 */
export async function persistAccessToken(
  c: any,
  input: {
    accessToken: string;
    accessTokenPayload: { jti?: string };
    subject: string;
    validatedRequest: ValidatedTokenRequest;
    issuedAt: number;
    audience: string[];
    acr: string | undefined;
  },
): Promise<void> {
  const { accessToken, accessTokenPayload, subject, validatedRequest, issuedAt, audience, acr } = input;
  const accessTokenStore = c.get('accessTokenStore');
  const config = c.get('config');

  await accessTokenStore.set(accessToken, {
    sub: subject,
    clientId: validatedRequest.clientId,
    scope: validatedRequest.scope,
    expiresAt: issuedAt + config.accessTokenExpiresIn,
    grantId: validatedRequest.grantId,
    iat: issuedAt,
    // RFC 7519 §4.1.5 / RFC 7662 §2.2: persist nbf (= iat) for JWT and opaque
    // tokens alike so introspection reports a not-yet-valid token inactive and
    // can echo nbf. The JWT issuer emits the same nbf = iat inside the token.
    nbf: issuedAt,
    audience,
    issuer: config.issuer,
    // RFC 9068 §2.2 / RFC 7662 §2.2: persist the token identifier core minted
    // for this issuance so introspection can echo jti. It is also what makes
    // two same-second issuances distinct token strings (RS256 is deterministic),
    // so this store key never collides across grants.
    jti: accessTokenPayload.jti,
    // OIDC Core 1.0 §5.5: persist the authorization request's claims parameter
    // so the UserInfo endpoint can honor claims.userinfo members (e.g.
    // {"userinfo":{"name":{"essential":true}}}) independently of scope.
    claims: validatedRequest.grantType === 'authorization_code' ? validatedRequest.claims : undefined,
    // RFC 9068 §2.2.1 / RFC 9470 §6.2: the acr the token was issued with, so
    // introspection reports it for an opaque token too.
    acr,
  });
}
