import {
  resolveClientForAuthorization,
  validateRegisteredRedirectUris,
  type ClientInfo,
} from '@maronn-openid-connect/core';
import type { AuthorizationRequestInput } from '../outcome.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'resolve-client',
  endpoint: 'authorize',
  kind: 'resolve',
  label: 'Resolve the client',
  spec: 'OAuth 2.1 §4.1.2.1 / RFC 8252 §8',
  function: 'resolveAuthorizationClient',
  calls: ['resolveClientForAuthorization', 'validateRegisteredRedirectUris'],
  consumes: ['params'],
  produces: ['client'],
  removable: false,
});

/**
 * Resolve client_id into the registered client and fail fast on misconfigured
 * registered redirect URIs (fragments, dangerous schemes, non-loopback http).
 * OAuth 2.1 §4.1.2.1 / OIDC Core 1.0 §3.1.2.1 / RFC 8252 §8
 *
 * Errors thrown here are not redirectable: the OP has no redirect_uri it may
 * trust yet, so they stay on the OP (OIDC Core 1.0 §3.1.2.2).
 */
export async function resolveAuthorizationClient(
  c: any,
  params: AuthorizationRequestInput,
): Promise<ClientInfo> {
  const clientResolver = c.get('clientResolver');
  const client = await resolveClientForAuthorization(params, clientResolver);
  validateRegisteredRedirectUris(client.redirectUris);
  return client;
}
