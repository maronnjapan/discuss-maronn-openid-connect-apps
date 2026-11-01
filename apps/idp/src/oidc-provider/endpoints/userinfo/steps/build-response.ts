import {
  type AccessTokenInfo,
  type UserInfoResponse,
  generateUserInfoJwt,
  selectSigningKeyByAlg,
  type SigningKey,
} from '@maronn-openid-connect/core';
import type { RegisteredClient } from '../../../config.js';
import { type UserInfoEndpointResponse, UserInfoEndpointError } from '../response.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'build-response',
  endpoint: 'userinfo',
  kind: 'transform',
  label: 'Build the response (JSON or signed JWT)',
  spec: 'OIDC Core 1.0 §5.3.2',
  function: 'buildUserInfoResponse',
  calls: ['selectSigningKeyByAlg', 'generateUserInfoJwt'],
  consumes: ['tokenInfo', 'claims'],
  produces: ['userInfoResponse'],
  removable: false,
});

/**
 * Build the response in the format the client registered: a signed JWT when
 * userinfo_signed_response_alg is set, JSON otherwise.
 * OIDC Core 1.0 §5.3.2
 */
export async function buildUserInfoResponse(
  c: any,
  tokenInfo: AccessTokenInfo,
  claims: UserInfoResponse,
): Promise<UserInfoEndpointResponse> {
  const clientResolver = c.get('clientResolver');
  const client = (await clientResolver.findClient(
    tokenInfo.clientId,
  )) as RegisteredClient | null;

  const requestedUserinfoAlg = client?.userinfoSignedResponseAlg;
  if (!requestedUserinfoAlg) {
    return { status: 200, body: claims };
  }

  // OIDC Core 1.0 §5.3.2: when the client registered userinfo_signed_response_alg,
  // the UserInfo Response MUST be a JWS signed with THAT alg (RS256, ES256, ...),
  // not unconditionally RS256. Pick a registered UserInfo signing key whose alg
  // matches the request — mirroring the ID Token key selection. A request whose
  // alg has no matching key is a server configuration error (never silently
  // signed with another alg).
  const config = c.get('config');
  const userinfoSigningKeys = (c.get('userinfoSigningKeys') as SigningKey[] | undefined) ?? [];
  let selectedUserinfoKey: SigningKey;
  try {
    selectedUserinfoKey = selectSigningKeyByAlg(userinfoSigningKeys, requestedUserinfoAlg);
  } catch {
    throw new UserInfoEndpointError({
      status: 500,
      body: {
        error: 'server_error',
        error_description: `No UserInfo signing key registered for alg "${requestedUserinfoAlg}"`,
      },
    });
  }
  const jwt = await generateUserInfoJwt(claims, {
    issuer: config.issuer,
    audience: client.clientId,
    privateKey: selectedUserinfoKey.privateKey,
    keyId: selectedUserinfoKey.keyId,
  });
  return { status: 200, text: jwt, headers: { 'Content-Type': 'application/jwt' } };
}
