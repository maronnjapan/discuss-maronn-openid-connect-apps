import { RevocationError, TokenError } from '@maronn-openid-connect/core';
import { RevocationEndpointError, noStore } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'respond-error',
  endpoint: 'revocation',
  feature: 'revocation',
  kind: 'respond',
  label: 'Respond with the OAuth error',
  spec: 'RFC 7009 §2.2.1',
  function: 'respondRevocationError',
  consumes: [],
  produces: [],
  removable: false,
});

/**
 * Answer a failure of any step with the OAuth error response.
 * RFC 7009 §2.2.1 / RFC 6749 §5.2
 */
export function respondRevocationError(c: any, error: unknown): Response {
  noStore(c);
  if (error instanceof RevocationEndpointError) {
    for (const [name, value] of Object.entries(error.response.headers ?? {})) {
      c.header(name, value);
    }
    return c.json(error.response.body, error.response.status);
  }
  if (error instanceof TokenError || error instanceof RevocationError) {
    if (error.wwwAuthenticate) c.header('WWW-Authenticate', error.wwwAuthenticate);
    return c.json(
      { error: error.error, error_description: error.errorDescription },
      error.statusCode,
    );
  }
  return c.json({ error: 'server_error' }, 500);
}
