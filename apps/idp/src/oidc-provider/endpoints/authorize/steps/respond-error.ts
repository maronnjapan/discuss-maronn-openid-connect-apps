import { AuthorizationError } from '@maronn-openid-connect/core';
import { type AuthorizationOutcome, buildErrorResponse } from '../outcome.js';
import type { AuthorizationResponseMode } from '../response-mode.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'respond-error',
  endpoint: 'authorize',
  kind: 'respond',
  label: 'Map a failure to a redirectable or on-OP error',
  spec: 'OIDC Core 1.0 §3.1.2.6 / §3.1.2.2',
  function: 'authorizationErrorOutcome',
  consumes: ['responseMode'],
  optional: ['responseMode'],
  produces: [],
  removable: false,
});

/**
 * Map a failure of any step to the outcome: a redirectable error goes back to
 * the client with the state and iss (RFC 9207 §2); an error thrown before the
 * redirect_uri was verified stays on the OP (OIDC Core 1.0 §3.1.2.2: unknown
 * client_id, unregistered redirect_uri, redirect_uri with a fragment);
 * anything else is a server_error.
 *
 * When the request asked for a response mode of a feature (JARM §2.1 signs
 * the error members into one JWT, the Form Post Response Mode posts them),
 * the error goes back in that mode.
 * responseMode is undefined for errors thrown before response_mode was
 * interpreted (unknown client, unsupported JWT mode), which is why those stay plain.
 */
export async function authorizationErrorOutcome(
  c: any,
  error: unknown,
  responseMode: AuthorizationResponseMode | undefined,
): Promise<AuthorizationOutcome> {
  if (error instanceof AuthorizationError) {
    if (error.redirectUri) {
      return {
        kind: 'authorization_response',
        response: await buildErrorResponse(
          responseMode,
          error.redirectUri,
          error.error,
          error.state,
          error.errorDescription,
          c.get('config').issuer,
        ),
      };
    }
    // OIDC Core 1.0 §3.1.2.2: errors that cannot be redirected MUST NOT
    // redirect to the supplied redirect_uri. They stay on the OP:
    // the authorization page (page.ts) answers programmatic callers (Accept:
    // application/json) with the OAuth error JSON and browsers with the OP's
    // own error page.
    return { kind: 'error', error: error.error, errorDescription: error.errorDescription };
  }
  return { kind: 'server_error' };
}
