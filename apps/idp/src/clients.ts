/**
 * The relying parties of the IdP, read from the OIDC_CLIENTS_JSON secret.
 *
 * OIDC_CLIENTS_JSON is a JSON array of ClientRegistration
 * (src/oidc-provider/config.ts) with one member of this app on top:
 * postLogoutRedirectUris, the post_logout_redirect_uri values the client may
 * use at the end session endpoint (RP-Initiated Logout 1.0 §3). It is kept
 * apart from redirectUris, as the generated logout feature expects.
 *
 * src/index.ts writes the clients to D1 with registerClient() on the first
 * request of each isolate, so changing the secret and redeploying is all a
 * client change takes. registerClient() stores only the hash of clientSecret.
 */
import type { ClientRegistration } from './oidc-provider/config.js';

export type ClientConfig = ClientRegistration & { postLogoutRedirectUris?: string[] };

export interface ParsedClients {
  registrations: ClientRegistration[];
  postLogoutRedirectUris: Record<string, string[]>;
}

export class ClientConfigError extends Error {}

export function parseClientsJson(value: string | undefined): ParsedClients {
  if (value === undefined || value.trim() === '') {
    return { registrations: [], postLogoutRedirectUris: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ClientConfigError('OIDC_CLIENTS_JSON is not valid JSON.');
  }
  if (!Array.isArray(parsed)) {
    throw new ClientConfigError('OIDC_CLIENTS_JSON must be a JSON array of clients.');
  }

  const registrations: ClientRegistration[] = [];
  const postLogoutRedirectUris: Record<string, string[]> = {};
  parsed.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new ClientConfigError(`OIDC_CLIENTS_JSON[${index}] is not an object.`);
    }
    const { postLogoutRedirectUris: logoutUris, ...registration } = entry as ClientConfig;
    if (typeof registration.clientId !== 'string' || registration.clientId === '') {
      throw new ClientConfigError(`OIDC_CLIENTS_JSON[${index}] has no clientId.`);
    }
    if (!Array.isArray(registration.redirectUris) || registration.redirectUris.length === 0) {
      throw new ClientConfigError(`OIDC_CLIENTS_JSON[${index}] (${registration.clientId}) has no redirectUris.`);
    }
    for (const uri of [...registration.redirectUris, ...(logoutUris ?? [])]) {
      if (!URL.canParse(uri)) {
        throw new ClientConfigError(`OIDC_CLIENTS_JSON[${index}] (${registration.clientId}) has an invalid URI: ${uri}`);
      }
    }
    registrations.push(registration);
    if (logoutUris !== undefined && logoutUris.length > 0) {
      postLogoutRedirectUris[registration.clientId] = [...logoutUris];
    }
  });
  return { registrations, postLogoutRedirectUris };
}
