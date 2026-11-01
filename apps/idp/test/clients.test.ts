import { describe, expect, it } from 'vitest';
import { ClientConfigError, parseClientsJson } from '../src/clients.js';

const planner = {
  clientId: 'planner',
  clientSecret: 'secret',
  clientType: 'confidential',
  redirectUris: ['https://planner.example.com/auth/callback'],
  postLogoutRedirectUris: ['https://planner.example.com/signed-out'],
  grantTypes: ['authorization_code'],
  responseTypes: ['code'],
  tokenEndpointAuthMethods: ['client_secret_basic'],
  scope: ['openid', 'profile', 'email'],
};

describe('parseClientsJson', () => {
  it('should split the logout redirect URIs from the client registration', () => {
    const { postLogoutRedirectUris: _, ...registration } = planner;
    expect(parseClientsJson(JSON.stringify([planner]))).toEqual({
      registrations: [registration],
      postLogoutRedirectUris: { planner: ['https://planner.example.com/signed-out'] },
    });
  });

  it('should return no clients for an empty secret', () => {
    expect(parseClientsJson(undefined)).toEqual({ registrations: [], postLogoutRedirectUris: {} });
  });

  it('should reject a value that is not an array', () => {
    expect(() => parseClientsJson('{}')).toThrow(new ClientConfigError('OIDC_CLIENTS_JSON must be a JSON array of clients.'));
  });

  it('should reject a client without redirect URIs', () => {
    expect(() => parseClientsJson(JSON.stringify([{ ...planner, redirectUris: [] }]))).toThrow(
      new ClientConfigError('OIDC_CLIENTS_JSON[0] (planner) has no redirectUris.'),
    );
  });

  it('should reject an invalid URI', () => {
    expect(() => parseClientsJson(JSON.stringify([{ ...planner, postLogoutRedirectUris: ['not a url'] }]))).toThrow(
      new ClientConfigError('OIDC_CLIENTS_JSON[0] (planner) has an invalid URI: not a url'),
    );
  });
});
