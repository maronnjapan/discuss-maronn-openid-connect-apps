/**
 * What the token endpoint reads and answers, and the failure a step answers
 * with a fixed response.
 */
import type { TokenRequestParams } from '@maronn-openid-connect/core';

/**
 * The form parameters of a token request: the fields OIDC Core / OAuth 2.1
 * name, plus every other field the client posted (the experimental grants
 * read their own parameters from it).
 */
export type TokenRequestBody = TokenRequestParams & Record<string, string>;

/** What the token endpoint answers; respondToken() turns it into HTTP. */
export interface TokenEndpointResponse {
  status: number;
  body: object;
  /** Headers beside the no-store pair every answer carries (e.g. WWW-Authenticate). */
  headers?: Record<string, string>;
}

/**
 * A failure a step answers with a fixed response: a malformed request (400)
 * or a server configuration problem (500). respondTokenError() sends the
 * response as it is.
 */
export class TokenEndpointError extends Error {
  constructor(readonly response: TokenEndpointResponse) {
    const details = response.body as { error?: unknown; error_description?: unknown };
    super(String(details.error_description ?? details.error ?? 'token endpoint error'));
    this.name = 'TokenEndpointError';
  }
}
