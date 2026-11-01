/**
 * The bearer token the routine sends its results with (Authorization:
 * Bearer). It is the value of a network secret of the routine's environment
 * (secret type "Bearer"): Anthropic's agent proxy adds it to the requests for
 * this app's host, outside the session's VM, so Claude never sees it.
 *
 * The token is a shared secret, not a token of the IdP. This app keeps only
 * its SHA-256 (ROUTINE_BEARER_TOKEN_HASH, base64url) and compares the hash of
 * the presented token with it in constant time.
 */
import type { AppConfig } from '../env.js';
import { timingSafeEqual, toBase64Url } from '../crypto.js';

export class RoutineTokenError extends Error {
  readonly error = 'invalid_token';
  readonly status = 401;

  constructor(readonly description: string) {
    super(description);
  }

  /** RFC 6750 §3. */
  get wwwAuthenticate(): string {
    return `Bearer error="${this.error}", error_description="${this.description}"`;
  }
}

/** The form of ROUTINE_BEARER_TOKEN_HASH: the base64url SHA-256 of the token. */
export const BEARER_TOKEN_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export async function hashBearerToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return toBase64Url(new Uint8Array(digest));
}

export async function verifyRoutineToken(config: AppConfig, request: Request): Promise<void> {
  // RFC 6750 §2.1, with the scheme case-insensitive. The token is not held to
  // the b64token characters: it is whatever value was saved in the network
  // secret, and only its hash is compared.
  const match = /^Bearer +(\S+)$/i.exec(request.headers.get('Authorization') ?? '');
  if (!match) throw new RoutineTokenError('A Bearer token is required');
  if (config.routineBearerTokenHash === null) {
    console.error('[planner] ROUTINE_BEARER_TOKEN_HASH is not set; every request of the routine is refused');
    throw new RoutineTokenError('The planner has no token for the routine configured');
  }
  if (!timingSafeEqual(await hashBearerToken(match[1]!), config.routineBearerTokenHash)) {
    throw new RoutineTokenError('The Bearer token is invalid');
  }
}
