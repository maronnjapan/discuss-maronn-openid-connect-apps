/**
 * The signing keys of the IdP, read from the OIDC_SIGNING_KEYS secret.
 *
 * Workers run the IdP in many isolates at once. A key generated at startup
 * would differ between isolates, and a relying party that fetched the JWKS
 * from one isolate could not verify an ID Token signed by another, so the
 * keys are fixed and shared through a secret instead.
 *
 * OIDC_SIGNING_KEYS is a JSON array of RSA private JWKs (RFC 7517), each
 * with a kid. The first key signs new tokens and every key is published at
 * the JWKS endpoint, so rotating means putting a new key first and keeping
 * the old one after it until the tokens it signed have expired.
 * scripts/signing-key.ts generates the keys.
 */
import type { SigningKey, SigningKeyProvider } from '@maronn-openid-connect/core';

interface RsaPrivateJwk {
  kty: 'RSA';
  kid: string;
  n: string;
  e: string;
  d: string;
  p?: string;
  q?: string;
  dp?: string;
  dq?: string;
  qi?: string;
}

export class SigningKeyConfigError extends Error {}

/** Parses OIDC_SIGNING_KEYS into the private JWKs, checking each one has what signing needs. */
export function parseSigningKeysJson(value: string | undefined): RsaPrivateJwk[] {
  if (value === undefined || value.trim() === '') {
    throw new SigningKeyConfigError(
      'OIDC_SIGNING_KEYS is not set. Generate a key with `pnpm --filter @apps/idp signing-key`.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SigningKeyConfigError('OIDC_SIGNING_KEYS is not valid JSON.');
  }
  const keys = Array.isArray(parsed) ? parsed : [parsed];
  if (keys.length === 0) {
    throw new SigningKeyConfigError('OIDC_SIGNING_KEYS must contain at least one key.');
  }
  const kids = new Set<string>();
  return keys.map((key, index) => {
    if (typeof key !== 'object' || key === null) {
      throw new SigningKeyConfigError(`OIDC_SIGNING_KEYS[${index}] is not a JWK object.`);
    }
    const jwk = key as Record<string, unknown>;
    if (jwk.kty !== 'RSA') {
      throw new SigningKeyConfigError(`OIDC_SIGNING_KEYS[${index}] must be an RSA key (kty "RSA").`);
    }
    for (const member of ['kid', 'n', 'e', 'd'] as const) {
      if (typeof jwk[member] !== 'string' || jwk[member] === '') {
        throw new SigningKeyConfigError(`OIDC_SIGNING_KEYS[${index}] has no "${member}".`);
      }
    }
    const kid = jwk.kid as string;
    if (kids.has(kid)) {
      throw new SigningKeyConfigError(`OIDC_SIGNING_KEYS has two keys with kid "${kid}".`);
    }
    kids.add(kid);
    return jwk as unknown as RsaPrivateJwk;
  });
}

/** The public half of a private JWK, as the JWKS endpoint publishes it. */
export function toPublicJwk(jwk: RsaPrivateJwk): JsonWebKey & { kid: string; use: string; alg: string } {
  return { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig', kid: jwk.kid };
}

async function importSigningKey(jwk: RsaPrivateJwk): Promise<SigningKey> {
  // Only the key material goes to importKey: "use" or "key_ops" in the stored
  // JWK must agree with the usages requested here, so they are left out.
  const { kid, ...material } = jwk;
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    { ...material, alg: 'RS256', ext: false },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return { privateKey, publicJwk: toPublicJwk(jwk), keyId: kid };
}

/**
 * A SigningKeyProvider over OIDC_SIGNING_KEYS. The keys are imported once per
 * isolate; a changed secret reaches the IdP with the next deployment.
 */
export function createSecretSigningKeyProvider(readSecret: () => string | undefined): SigningKeyProvider {
  let keys: Promise<SigningKey[]> | undefined;
  return {
    getSigningKeys() {
      keys ??= Promise.resolve()
        .then(() => Promise.all(parseSigningKeysJson(readSecret()).map(importSigningKey)))
        .catch((error: unknown) => {
          keys = undefined;
          console.error('[idp] failed to load the signing keys:', error instanceof Error ? error.message : error);
          throw error;
        });
      return keys;
    },
  };
}

/** A new RS256 key pair as a private JWK, for scripts/signing-key.ts. */
export async function generateSigningJwk(kid: string): Promise<RsaPrivateJwk> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  return {
    kty: 'RSA',
    kid,
    n: jwk.n!,
    e: jwk.e!,
    d: jwk.d!,
    p: jwk.p,
    q: jwk.q,
    dp: jwk.dp,
    dq: jwk.dq,
    qi: jwk.qi,
  };
}
