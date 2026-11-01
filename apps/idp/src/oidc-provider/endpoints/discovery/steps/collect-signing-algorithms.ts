import { getJwaAlgorithm, type SigningKey } from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'collect-signing-algorithms',
  endpoint: 'discovery',
  kind: 'resolve',
  label: 'Collect the advertised signing algorithms',
  spec: 'OIDC Core 1.0 §15.1 / §5.3.2',
  function: 'collectAdvertisedSigningKeys',
  calls: ['getJwaAlgorithm'],
  consumes: [],
  produces: ['idTokenSigningKeys', 'userinfoSigningAlgValues'],
  removable: false,
});

/**
 * Collect what the registered key sets let the OP advertise: the ID Token
 * signing keys (id_token_signing_alg_values_supported is derived from them,
 * OIDC Core 1.0 §15.1) and the UserInfo signing algorithms (§5.3.2).
 */
export function collectAdvertisedSigningKeys(c: any): {
  idTokenSigningKeys: CryptoKey[];
  userinfoSigningAlgValues: string[];
} {
  // Derive id_token_signing_alg_values_supported from the actual key set
  // (OIDC Core 1.0 §15.1 — RS256 presence is enforced by buildProviderMetadata).
  // T-022: 全 registered ID Token 鍵の alg を集約することで RS256+ES256 など
  // 混在鍵セットも正しく advertise できる。
  const idTokenSigningKeyArr = (c.get('idTokenSigningKeys') as SigningKey[] | undefined) ?? [];
  const idTokenSigningKeys: CryptoKey[] = idTokenSigningKeyArr.map((k) => k.privateKey);

  // OIDC Core 1.0 §5.3.2 / §3 discovery: advertise the UserInfo signing algs the OP
  // can actually sign with, derived from the registered UserInfo key set (RS256,
  // ES256, ...), so userinfo_signed_response_alg clients can rely on metadata.
  const userinfoSigningKeyArr = (c.get('userinfoSigningKeys') as SigningKey[] | undefined) ?? [];
  const userinfoSigningAlgValues = [
    ...new Set(userinfoSigningKeyArr.map((k) => getJwaAlgorithm(k.privateKey))),
  ];
  return { idTokenSigningKeys, userinfoSigningAlgValues };
}
