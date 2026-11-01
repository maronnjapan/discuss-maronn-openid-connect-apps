import {
  type AuthorizationRequestParams,
  type ClientInfo,
  resolveAuthorizationRedirectUri,
} from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'resolve-redirect-uri',
  endpoint: 'authorize',
  kind: 'resolve',
  label: 'Resolve redirect_uri (errors become redirectable)',
  spec: 'OIDC Core 1.0 §3.1.2.1 / RFC 6749 §4.1.2.1',
  function: 'resolveRedirectTarget',
  calls: ['resolveAuthorizationRedirectUri'],
  consumes: ['params', 'effectiveParams', 'client'],
  optional: ['effectiveParams'],
  produces: ['redirectUri', 'state'],
  removable: false,
});

/**
 * Resolve redirect_uri against the registered URIs.
 * OIDC Core 1.0 §3.1.2.1 / RFC 6749 §4.1.2.1
 *
 * From here on an error is redirectable: it is sent to the client together
 * with the request's state. Everything before this step stays on the OP.
 */
export function resolveRedirectTarget(
  params: AuthorizationRequestParams,
  client: ClientInfo,
): { redirectUri: string; state: string | undefined } {
  const redirectUri = resolveAuthorizationRedirectUri(params, client);
  return { redirectUri, state: params.state };
}
