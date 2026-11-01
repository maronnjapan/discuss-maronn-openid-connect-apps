import {
  type SigningKey,
  exportJwks,
  extractAlgorithmParamsFromJwk,
  type JwkSet,
} from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'export-jwks',
  endpoint: 'jwks',
  kind: 'transform',
  label: 'Export the public halves as a JWK Set',
  spec: 'RFC 7517 §5',
  function: 'buildJwksDocument',
  calls: ['extractAlgorithmParamsFromJwk', 'exportJwks'],
  consumes: ['keys'],
  produces: ['jwks'],
  removable: false,
});

/**
 * Export the public halves as a JWK Set (RFC 7517 §5). kid 指定がある鍵は kid で
 * 重複排除し、kid 未指定の鍵は最新の 1 件のみ採用する（鍵セットは新しい鍵ほど
 * 先頭にある）。An empty key set is a server configuration error.
 */
export async function buildJwksDocument(keys: SigningKey[]): Promise<JwkSet> {
  if (keys.length === 0) {
    throw new Error('No signing key is registered');
  }

  // 同じ kid の鍵は最初に出現したものだけを採用する（ID Token / UserInfo 用の
  // プロバイダは既定で汎用プロバイダと同じ鍵を返すため）。kid 未指定の鍵も同様に
  // 最初の 1 件（= 最新）だけを採用する。
  const seenKids = new Set<string>();
  const entries: { publicKey: CryptoKey; keyId?: string }[] = [];
  for (const key of keys) {
    if (seenKids.has(key.keyId)) continue;
    seenKids.add(key.keyId);
    const jwk = key.publicJwk as JsonWebKey;
    const algParams = extractAlgorithmParamsFromJwk(jwk);
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      algParams,
      true,
      ['verify'],
    );
    entries.push({ publicKey, keyId: key.keyId });
  }

  return exportJwks(entries);
}
