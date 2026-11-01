import {
  type ClientInfo,
  resolveRequestObjectParams,
  type ResolvedRequestObjectParams,
} from '@maronn-openid-connect/core';
import type { AuthorizationRequestInput } from '../../../endpoints/authorize/outcome.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'resolve-request-object',
  endpoint: 'authorize',
  feature: 'request-object',
  kind: 'resolve',
  label: 'Verify the Request Object and overlay its claims',
  spec: 'OIDC Core 1.0 §6.1',
  function: 'resolveRequestObject',
  calls: ['resolveRequestObjectParams'],
  consumes: ['params', 'client'],
  produces: ['effectiveParams', 'requestObjectClaims'],
  removable: false,
});

/**
 * Verify the signed Request Object (request parameter) against the keys the
 * client registered for the request_object purpose and overlay its claims
 * onto the query parameters.
 * OIDC Core 1.0 §6.1 / §6.3.2
 *
 * RS256 is required; alg=none is accepted only when
 * config.allowUnsignedRequestObject is enabled (conformance compat).
 * effectiveParams is what every later step validates.
 */
export async function resolveRequestObject(
  c: any,
  params: AuthorizationRequestInput,
  client: ClientInfo,
): Promise<ResolvedRequestObjectParams> {
  const config = c.get('config');
  const clientKeyResolver = c.get('clientKeyResolver');
  // The keys are read only for a request that carries a Request Object.
  const jwks = params.request === undefined
    ? undefined
    : await clientKeyResolver.findClientKeys(client.clientId, 'request_object');
  return resolveRequestObjectParams(params, { jwks, allowUnsigned: config.allowUnsignedRequestObject });
}
