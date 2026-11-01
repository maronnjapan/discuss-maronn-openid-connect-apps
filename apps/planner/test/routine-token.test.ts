import { describe, expect, it, vi } from 'vitest';
import { RoutineTokenError, hashBearerToken, verifyRoutineToken } from '../src/auth/routine-token.js';
import { readConfig, ConfigError, type AppConfig, type Bindings } from '../src/env.js';

const PLANNER = 'https://planner.example.com';
// Not limited to the b64token characters of RFC 6750: a value saved in a network secret may hold any of them.
const TOKEN = 'oD4&test#N@token!with*symbols';

const configWith = async (token: string | null) =>
  ({ appOrigin: PLANNER, routineBearerTokenHash: token === null ? null : await hashBearerToken(token) }) as AppConfig;

function request(authorization?: string) {
  const headers: Record<string, string> = authorization === undefined ? {} : { Authorization: authorization };
  return new Request(`${PLANNER}/api/routine/runs/run_1/messages`, { method: 'POST', headers });
}

async function rejection(config: AppConfig, authorization?: string) {
  return verifyRoutineToken(config, request(authorization)).then(
    () => null,
    (error: unknown) =>
      error instanceof RoutineTokenError ? { error: error.error, status: error.status, description: error.description } : error,
  );
}

describe('verifyRoutineToken', () => {
  it('should accept the token whose hash is configured', async () => {
    await expect(verifyRoutineToken(await configWith(TOKEN), request(`Bearer ${TOKEN}`))).resolves.toBeUndefined();
  });

  // RFC 6750 §2.1: the auth-scheme is case-insensitive
  it('should accept the scheme in any case', async () => {
    await expect(verifyRoutineToken(await configWith(TOKEN), request(`bearer ${TOKEN}`))).resolves.toBeUndefined();
  });

  it('should require a Bearer token', async () => {
    expect(await rejection(await configWith(TOKEN))).toEqual({ error: 'invalid_token', status: 401, description: 'A Bearer token is required' });
    expect(await rejection(await configWith(TOKEN), `Basic ${btoa('a:b')}`)).toEqual({
      error: 'invalid_token',
      status: 401,
      description: 'A Bearer token is required',
    });
  });

  it('should reject another token', async () => {
    expect(await rejection(await configWith(TOKEN), `Bearer ${TOKEN}x`)).toEqual({
      error: 'invalid_token',
      status: 401,
      description: 'The Bearer token is invalid',
    });
  });

  // The IdP no longer takes part: its access tokens are not the routine's token.
  it('should reject a JWT access token', async () => {
    expect(await rejection(await configWith(TOKEN), 'Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln')).toEqual({
      error: 'invalid_token',
      status: 401,
      description: 'The Bearer token is invalid',
    });
  });

  it('should refuse every token while none is configured', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await rejection(await configWith(null), `Bearer ${TOKEN}`)).toEqual({
      error: 'invalid_token',
      status: 401,
      description: 'The planner has no token for the routine configured',
    });
    consoleError.mockRestore();
  });

  it('should say why in WWW-Authenticate (RFC 6750 §3)', () => {
    expect(new RoutineTokenError('The Bearer token is invalid').wwwAuthenticate).toBe(
      'Bearer error="invalid_token", error_description="The Bearer token is invalid"',
    );
  });
});

describe('hashBearerToken', () => {
  // The same base64url SHA-256 as scripts/lib.mjs hashSecret(), which the deploy script stores.
  it('should make the base64url SHA-256 of the token', async () => {
    expect(await hashBearerToken('abc')).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
  });
});

describe('readConfig ROUTINE_BEARER_TOKEN_HASH', () => {
  const env = {
    APP_ORIGIN: PLANNER,
    OIDC_ISSUER: 'https://idp.example.com',
    OIDC_CLIENT_ID: 'planner',
    OIDC_CLIENT_SECRET: 'secret',
  } as Bindings;

  it('should read the hash', async () => {
    const hash = await hashBearerToken(TOKEN);
    expect(readConfig({ ...env, ROUTINE_BEARER_TOKEN_HASH: hash }).routineBearerTokenHash).toBe(hash);
  });

  it('should be null when unset', () => {
    expect(readConfig(env).routineBearerTokenHash).toBeNull();
  });

  it('should reject a value that is not a hash, such as the token itself', () => {
    expect(() => readConfig({ ...env, ROUTINE_BEARER_TOKEN_HASH: TOKEN })).toThrow(ConfigError);
  });
});
