import { IntrospectionError, TokenError } from '@maronn-openid-connect/core';
import { IntrospectionEndpointError } from '../response.js';
import { respondIntrospection } from './respond.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'respond-error',
  endpoint: 'introspection',
  feature: 'introspection',
  kind: 'respond',
  label: 'Respond with the OAuth error',
  spec: 'RFC 7662 §2.3',
  function: 'respondIntrospectionError',
  consumes: [],
  produces: [],
  removable: false,
});

/**
 * Answer a failure of any step with the OAuth error response.
 * RFC 7662 §2.3 / RFC 6749 §5.2
 */
export function respondIntrospectionError(c: any, error: unknown): Response {
  if (error instanceof IntrospectionEndpointError) {
    return respondIntrospection(c, error.response);
  }
  if (error instanceof TokenError || error instanceof IntrospectionError) {
    return respondIntrospection(c, {
      status: error.statusCode,
      body: { error: error.error, error_description: error.errorDescription },
      headers: error.wwwAuthenticate ? { 'WWW-Authenticate': error.wwwAuthenticate } : undefined,
    });
  }
  return respondIntrospection(c, { status: 500, body: { error: 'server_error' } });
}
