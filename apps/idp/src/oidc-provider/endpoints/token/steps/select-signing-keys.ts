import { selectSigningKeyByAlg, type SigningKey } from '@maronn-openid-connect/core';
import type { RegisteredClient } from '../../../config.js';
import { TokenEndpointError } from '../response.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'select-signing-keys',
  endpoint: 'token',
  kind: 'resolve',
  label: 'Select the signing keys',
  spec: 'OIDC Dynamic Client Registration 1.0 §2 (id_token_signed_response_alg)',
  function: 'selectTokenSigningKeys',
  calls: ['selectSigningKeyByAlg'],
  consumes: ['authenticatedClientId'],
  produces: ['signingKey', 'idTokenSigningKey'],
  removable: false,
});

/**
 * Select the signing keys: the first registered key signs the access token
 * (SigningKeyProvider contract); the ID Token key is picked by the alg the
 * client registered as id_token_signed_response_alg (OIDC Dynamic Client
 * Registration 1.0 §2; RS256 when unregistered). No matching key is a server
 * configuration error (TokenEndpointError, 500 server_error).
 */
export async function selectTokenSigningKeys(
  c: any,
  authenticatedClientId: string,
): Promise<{ signingKey: SigningKey; idTokenSigningKey: SigningKey }> {
  const tokenClientResolver = c.get('tokenClientResolver');
  // The first registered key signs new tokens (SigningKeyProvider contract).
  const signingKey: SigningKey = c.get('signingKeys')[0];

  // T-022: pick an ID Token signing key whose alg matches the client's
  // id_token_signed_response_alg (OIDC Dynamic Client Registration §2).
  // - 未指定クライアントは OIDC 仕様デフォルトの RS256 で扱う。
  // - alg に合う鍵が登録されていなければサーバ設定エラー (server_error)。
  const idTokenSigningKeys = (c.get('idTokenSigningKeys') as SigningKey[] | undefined) ?? [];
  const registeredClient = (await tokenClientResolver.findClient(authenticatedClientId)) as
    | RegisteredClient
    | null;
  const requestedIdTokenAlg = registeredClient?.idTokenSignedResponseAlg;
  let idTokenSigningKey: SigningKey;
  try {
    idTokenSigningKey = selectSigningKeyByAlg(idTokenSigningKeys, requestedIdTokenAlg);
  } catch {
    throw new TokenEndpointError({
      status: 500,
      body: {
        error: 'server_error',
        error_description: `No ID Token signing key registered for alg "${requestedIdTokenAlg ?? 'RS256'}"`,
      },
    });
  }
  return { signingKey, idTokenSigningKey };
}
