import { describe, expect, it } from 'vitest';
import {
  createSecretSigningKeyProvider,
  generateSigningJwk,
  parseSigningKeysJson,
  SigningKeyConfigError,
  toPublicJwk,
} from '../src/signing-keys.js';

describe('parseSigningKeysJson', () => {
  it('should reject a missing secret with the command that generates one', () => {
    expect(() => parseSigningKeysJson(undefined)).toThrow(
      new SigningKeyConfigError('OIDC_SIGNING_KEYS is not set. Generate a key with `pnpm --filter @apps/idp signing-key`.'),
    );
  });

  it('should reject a key that is not RSA', () => {
    expect(() => parseSigningKeysJson(JSON.stringify([{ kty: 'EC', kid: 'a' }]))).toThrow(
      new SigningKeyConfigError('OIDC_SIGNING_KEYS[0] must be an RSA key (kty "RSA").'),
    );
  });

  it('should reject a key without the private exponent', () => {
    expect(() => parseSigningKeysJson(JSON.stringify([{ kty: 'RSA', kid: 'a', n: 'n', e: 'AQAB' }]))).toThrow(
      new SigningKeyConfigError('OIDC_SIGNING_KEYS[0] has no "d".'),
    );
  });

  it('should reject two keys with the same kid', () => {
    const key = { kty: 'RSA', kid: 'same', n: 'n', e: 'AQAB', d: 'd' };
    expect(() => parseSigningKeysJson(JSON.stringify([key, key]))).toThrow(
      new SigningKeyConfigError('OIDC_SIGNING_KEYS has two keys with kid "same".'),
    );
  });

  it('should accept a single JWK object as a set of one key', () => {
    const key = { kty: 'RSA', kid: 'one', n: 'n', e: 'AQAB', d: 'd' };
    expect(parseSigningKeysJson(JSON.stringify(key))).toEqual([key]);
  });
});

describe('toPublicJwk', () => {
  it('should publish only the public members with alg, use and kid', () => {
    expect(toPublicJwk({ kty: 'RSA', kid: 'k1', n: 'nn', e: 'AQAB', d: 'secret', p: 'p', q: 'q' })).toEqual({
      kty: 'RSA',
      n: 'nn',
      e: 'AQAB',
      alg: 'RS256',
      use: 'sig',
      kid: 'k1',
    });
  });
});

describe('createSecretSigningKeyProvider', () => {
  it('should import the keys in order, the first one signing new tokens', async () => {
    const first = await generateSigningJwk('first');
    const second = await generateSigningJwk('second');
    const provider = createSecretSigningKeyProvider(() => JSON.stringify([first, second]));
    const keys = await provider.getSigningKeys();
    expect(keys.map((key) => key.keyId)).toEqual(['first', 'second']);
    expect(keys[0]!.privateKey.type).toBe('private');
    expect(keys[0]!.privateKey.algorithm).toMatchObject({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048 });
    expect(keys[0]!.publicJwk).toEqual(toPublicJwk(first));
  });

  it('should produce signatures the published public key verifies', async () => {
    const jwk = await generateSigningJwk('verify');
    const [key] = await createSecretSigningKeyProvider(() => JSON.stringify([jwk])).getSigningKeys();
    const data = new TextEncoder().encode('header.payload');
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key!.privateKey, data);
    const publicKey = await crypto.subtle.importKey('jwk', key!.publicJwk as JsonWebKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signature, data)).toBe(true);
  });

  it('should try again after a failure instead of caching it', async () => {
    let secret: string | undefined;
    const provider = createSecretSigningKeyProvider(() => secret);
    await expect(provider.getSigningKeys()).rejects.toThrow(SigningKeyConfigError);
    secret = JSON.stringify([await generateSigningJwk('later')]);
    expect((await provider.getSigningKeys()).map((key) => key.keyId)).toEqual(['later']);
  });
});
