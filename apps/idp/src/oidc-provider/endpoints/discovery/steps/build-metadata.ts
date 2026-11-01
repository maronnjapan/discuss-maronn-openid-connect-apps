import { buildProviderMetadata } from '@maronn-openid-connect/core';
import type { ProviderConfig } from '../../../config.js';
import { features } from '../../../features/enabled.js';
import { discoveryOf, tokenGrantsOf } from '../../../features/feature.js';
import { ADVERTISED_SCOPES } from '../../../scopes.js';
import { supportedResponseTypes } from '../../authorize/response-type.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'build-metadata',
  endpoint: 'discovery',
  kind: 'transform',
  label: 'Build the provider metadata',
  spec: 'OIDC Discovery 1.0 §3 / RFC 8414',
  function: 'buildDiscoveryMetadata',
  calls: ['supportedResponseTypes', 'buildProviderMetadata'],
  consumes: ['idTokenSigningKeys', 'userinfoSigningAlgValues'],
  produces: ['metadata'],
  removable: false,
});

/**
 * Build the provider metadata document.
 * OIDC Discovery 1.0 §3 / RFC 8414
 *
 * Every endpoint URL is built on config.issuer. The members below are those
 * of every provider; each feature adds its own (its endpoint, the grants it
 * answers, the response modes it signs) through the discovery entry of its
 * feature.ts.
 */
export function buildDiscoveryMetadata(
  c: any,
  input: { idTokenSigningKeys: CryptoKey[]; userinfoSigningAlgValues: string[] },
): Record<string, unknown> {
  const { idTokenSigningKeys, userinfoSigningAlgValues } = input;
  const config: ProviderConfig = c.get('config');
  const issuer = config.issuer;

  const metadata = buildProviderMetadata({
    issuer,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    jwksUri: `${issuer}/.well-known/jwks.json`,
    // code, and the response types a feature answers (the Implicit Flow's
    // id_token and id_token token, the Hybrid Flow's code id_token, code token
    // and code id_token token: authorize.responseTypes of its feature.ts).
    responseTypesSupported: supportedResponseTypes(),
    // OAuth 2.0 Multiple Response Type Encoding Practices §2.1 / OIDC Discovery 1.0 §3:
    // the authorization code flow returns its authorization response via
    // query. A feature that answers in another response mode (the fragment of
    // the Implicit and Hybrid Flows, form_post, JARM) adds it to this list.
    responseModesSupported: ['query'],
    subjectTypesSupported: ['public'],
    idTokenSigningKeys,
    userinfoEndpoint: `${issuer}/userinfo`,
    // scopes.ts: the scopes of OIDC Core and the declared custom scopes.
    // offline_access comes with the refresh-token feature, which grants it.
    scopesSupported: [...ADVERTISED_SCOPES],
    // OIDC Discovery 1.0 §3 / Core 1.0 §5.6: this OP produces Normal Claims only
    // (no _claim_names / _claim_sources), so advertise ['normal'] explicitly to make
    // the lack of Aggregated/Distributed support machine-readable.
    claimTypesSupported: ['normal'],
    claimsSupported: [
      'sub',
      'iss',
      'aud',
      'exp',
      'iat',
      // OIDC Core 1.0 §2 / §3.1.3.6: ID Token protocol claims the OP issues
      // (the issue-id-token step of endpoints/token/). auth_time/nonce/acr/amr
      // are set from the auth context, azp for multi-audience tokens, at_hash
      // for the access token issued with the ID Token (§3.1.3.6 / §3.2.2.10).
      // c_hash (§3.3.2.11) comes with the hybrid-flow feature, which
      // advertises it through the discovery entry of its feature.ts.
      'auth_time',
      'nonce',
      'acr',
      'amr',
      'azp',
      'at_hash',
      'name',
      'family_name',
      'given_name',
      'middle_name',
      'nickname',
      'preferred_username',
      'profile',
      'picture',
      'website',
      'gender',
      'birthdate',
      'zoneinfo',
      'locale',
      'updated_at',
      'email',
      'email_verified',
      'address',
      'phone_number',
      'phone_number_verified',
    ],
    // The authorization_code grant, and the grants the features answer at the
    // token endpoint (the token entry of their feature.ts). A feature that
    // answers a grant at the authorization endpoint (the implicit grant of
    // the Implicit and Hybrid Flows) adds it through the discovery entry of
    // its feature.ts.
    grantTypesSupported: ['authorization_code', ...tokenGrantsOf(features)],
    // RFC 6749 §2.1 / OAuth 2.1 §2.4: 'none' advertises that public clients
    // (no client_secret) are accepted at the token endpoint.
    tokenEndpointAuthMethodsSupported: [
      'client_secret_basic',
      'client_secret_post',
      'none',
    ],
    // Required when any client uses userinfo_signed_response_alg
    // (OIDC Core 1.0 Section 5.3.2). Derived from the registered UserInfo key set so
    // ES256 (and other) algs are advertised once a matching key is configured.
    userinfoSigningAlgValuesSupported: userinfoSigningAlgValues,
    // OIDC Core 1.0 §6.3: the request parameter (Request Object) is supported
    // only by the request-object feature, which advertises it. request_uri
    // (§6.2) is not supported, so it is explicitly advertised as false
    // (Discovery defaults request_uri_parameter_supported to true when omitted).
    requestParameterSupported: false,
    requestUriParameterSupported: false,
    // OIDC Discovery 1.0 §3 / Core 1.0 §5.5: the 'claims' request parameter is
    // implemented for both the ID Token and UserInfo paths, so it is advertised
    // as supported. Without this (defaults to false) spec-compliant RPs would
    // never send the 'claims' parameter.
    claimsParameterSupported: true,
    // RFC 9207 §3: authorize endpoint adds iss to all authorization responses.
    authorizationResponseIssParameterSupported: true,
  });

  // code_challenge_methods_supported is defined in OAuth 2.1 / PKCE spec,
  // not in OIDC Discovery, so it is added separately.
  return discoveryOf(
    features,
    { ...metadata, code_challenge_methods_supported: ['S256'] },
    issuer,
    config,
  );
}
