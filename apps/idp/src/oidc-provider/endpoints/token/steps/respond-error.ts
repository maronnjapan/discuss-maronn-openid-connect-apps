import { TokenError } from '@maronn-openid-connect/core';
import { TokenEndpointError } from '../response.js';
import { respondToken } from './respond.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'respond-error',
  endpoint: 'token',
  kind: 'respond',
  label: 'Respond with the OAuth error',
  spec: 'RFC 6749 §5.2 / RFC 6750 §3',
  function: 'respondTokenError',
  consumes: [],
  produces: [],
  removable: false,
});

/**
 * Answer a failure of any step with the OAuth error response.
 * RFC 6749 §5.2 / RFC 6750 §3 / OAuth 2.1 §5.2
 */
export function respondTokenError(c: any, error: unknown): Response {
  // A step already decided the whole response (malformed request, server
  // configuration problem, or the error of a grant a feature answers): send
  // it as it is.
  if (error instanceof TokenEndpointError) {
    return respondToken(c, error.response);
  }
  if (error instanceof TokenError) {
    // RFC 6750 Section 3 / OAuth 2.1 Section 5.2: 401 responses include WWW-Authenticate
    return respondToken(c, {
      status: error.statusCode,
      body: { error: error.error, error_description: error.errorDescription },
      headers: error.wwwAuthenticate ? { 'WWW-Authenticate': error.wwwAuthenticate } : undefined,
    });
  }
  // RFC 6749 Section 5.2: server_error responses MUST NOT be cached either.
  return respondToken(c, { status: 500, body: { error: 'server_error' } });
}
