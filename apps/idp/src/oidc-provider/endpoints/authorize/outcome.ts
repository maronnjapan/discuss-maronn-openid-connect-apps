/**
 * What the authorization endpoint decides, and the authorization responses it
 * sends back to the client.
 */
import {
  sanitizeErrorDescription,
  type AuthorizationRequestParams,
  type AuthTransaction,
} from '@maronn-openid-connect/core';
import {
  plainQueryResponse,
  type AuthorizationResponse,
  type AuthorizationResponseMode,
} from './response-mode.js';

/** What the authorization endpoint decided; page.ts turns it into HTTP. */
export type AuthorizationOutcome =
  /** Malformed transport: OAuth error JSON (400), no transaction exists yet. */
  | { kind: 'bad_request'; error: string; errorDescription: string }
  /**
   * The authorization response for the client — code or redirectable error,
   * in the response mode the request asked for: a redirect, or a form the
   * browser posts.
   */
  | { kind: 'authorization_response'; response: AuthorizationResponse }
  /**
   * Interactive authentication is needed: continue on the login screen. cookies
   * carries the transaction cookie, the only place the transaction id goes.
   */
  | { kind: 'login'; cookies: string[] }
  /** The End-User is signed in but consent is needed: continue on the consent screen. */
  | { kind: 'consent'; cookies: string[] }
  /** OIDC Core 1.0 §3.1.2.2: the error cannot be redirected and stays on the OP. */
  | { kind: 'error'; error: string; errorDescription?: string }
  /** An unexpected failure: OAuth error JSON (500). */
  | { kind: 'server_error' };

/**
 * The request parameters as parsed: the fields OIDC Core 1.0 §3.1.2.1 names,
 * plus every other parameter the client sent.
 */
export type AuthorizationRequestInput = AuthorizationRequestParams & Record<string, string>;

/** The transaction the pipeline created, with the lifetime its cookie gets. */
export interface AuthorizationTransaction {
  transactionId: string;
  transaction: AuthTransaction;
  transactionTtlSeconds: number;
}

/**
 * Narrows raw query-string params to the typed AuthorizationRequestParams.
 * PKCE parameters are validated by core so conformance compatibility mode can
 * intentionally pass requests that omit them.
 */
export function isAuthorizationRequestParams(
  params: unknown,
): params is AuthorizationRequestParams {
  if (typeof params !== 'object' || params === null) return false;
  const p = params as Record<string, unknown>;
  return typeof p['client_id'] === 'string';
}

/**
 * Builds the OAuth error response for the client.
 * OIDC Core 1.0 Section 3.1.2.6 / RFC 6749 Section 4.1.2.1.
 *
 * errorDescription is optional; when supplied it is sanitized to the RFC 6749
 * Section 5.2 allowed character set, so user-controlled fragments cannot
 * smuggle control bytes into the response.
 *
 * In the plain query response the parameters are added to the redirect URI,
 * with iss (RFC 9207 Section 2) so the client can pin the issuer that
 * produced it.
 *
 * When the request asked for a response mode of a feature (responseMode),
 * that mode carries the very same parameters instead — a JARM response JWT,
 * for one, identifies the issuer with its iss claim (RFC 9700 Section 2.1
 * accepts JARM as the issuer-identification mechanism), and the Form Post
 * Response Mode posts them, iss included, from an HTML form.
 */
export async function buildErrorResponse(
  responseMode: AuthorizationResponseMode | undefined,
  redirectUri: string,
  error: string,
  state: string | undefined,
  errorDescription: string | undefined,
  issuer: string,
): Promise<AuthorizationResponse> {
  // RFC 6749 Section 5.2: sanitize once, for every response mode.
  const description = errorDescription
    ? sanitizeErrorDescription(errorDescription)
    : undefined;
  const parameters = { error, error_description: description, state };
  if (responseMode) {
    return responseMode.respond(redirectUri, parameters);
  }
  return plainQueryResponse(redirectUri, parameters, issuer);
}

/**
 * Builds the success response carrying the authorization code.
 * OIDC Core 1.0 Section 3.1.2.5 / RFC 9207 Section 2 (iss).
 *
 * When the request asked for a response mode of a feature (responseMode),
 * that mode carries the code and state instead.
 */
export async function buildSuccessResponse(
  responseMode: AuthorizationResponseMode | undefined,
  redirectUri: string,
  code: string,
  state: string | undefined,
  issuer: string,
): Promise<AuthorizationResponse> {
  const parameters = { code, state };
  if (responseMode) {
    return responseMode.respond(redirectUri, parameters);
  }
  return plainQueryResponse(redirectUri, parameters, issuer);
}
