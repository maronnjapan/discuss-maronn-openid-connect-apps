/**
 * Sign-in through the IdP: OpenID Connect Authorization Code Flow with PKCE
 * (S256), state and nonce, as a confidential client (client_secret_basic).
 *
 * oauth4webapi does the protocol checks: the issuer of the discovery
 * document, the iss of the authorization response (RFC 9207, which the IdP
 * advertises), the token response and the ID Token claims (iss, aud, exp,
 * iat, nonce). The ID Token signature is verified against the IdP's JWKS as
 * well, which matters for local development where the IdP is plain HTTP.
 */
import * as oauth from 'oauth4webapi';
import type { AppConfig, Bindings } from '../env.js';

export const SCOPE = 'openid profile email';
const LOGIN_ATTEMPT_TTL = 600;

export interface SignedInUser {
  sub: string;
  name: string | null;
  email: string | null;
  idToken: string;
}

export type RequestOptions = {
  [oauth.customFetch]?: (url: string, init: { method: string; headers: Record<string, string>; body?: unknown; redirect?: 'manual'; signal?: AbortSignal }) => Promise<Response>;
  [oauth.allowInsecureRequests]?: boolean;
};

export function requestOptions(config: AppConfig, env: Bindings): RequestOptions {
  const issuerOrigin = new URL(config.issuer).origin;
  const options: RequestOptions = {};
  if (env.IDP) {
    const idp = env.IDP;
    options[oauth.customFetch] = (url, init) =>
      new URL(url).origin === issuerOrigin ? idp.fetch(url, init as RequestInit) : fetch(url, init as RequestInit);
  }
  // Local development runs the IdP on http://localhost.
  if (config.issuer.startsWith('http://')) options[oauth.allowInsecureRequests] = true;
  return options;
}

const metadataCache = new Map<string, { as: oauth.AuthorizationServer; expiresAt: number }>();

export async function authorizationServer(config: AppConfig, env: Bindings): Promise<oauth.AuthorizationServer> {
  const cached = metadataCache.get(config.issuer);
  if (cached && cached.expiresAt > Date.now()) return cached.as;
  const issuer = new URL(config.issuer);
  const response = await oauth.discoveryRequest(issuer, { algorithm: 'oidc', ...requestOptions(config, env) });
  const as = await oauth.processDiscoveryResponse(issuer, response);
  metadataCache.set(config.issuer, { as, expiresAt: Date.now() + 10 * 60_000 });
  return as;
}

function client(config: AppConfig): oauth.Client {
  return { client_id: config.clientId };
}

export interface LoginStart {
  url: string;
  state: string;
  codeVerifier: string;
  nonce: string;
  expiresAt: number;
}

export async function startLogin(config: AppConfig, env: Bindings): Promise<LoginStart> {
  const as = await authorizationServer(config, env);
  if (!as.authorization_endpoint) throw new Error('The IdP has no authorization_endpoint');
  const codeVerifier = oauth.generateRandomCodeVerifier();
  const state = oauth.generateRandomState();
  const nonce = oauth.generateRandomNonce();
  const url = new URL(as.authorization_endpoint);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', await oauth.calculatePKCECodeChallenge(codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return {
    url: url.href,
    state,
    codeVerifier,
    nonce,
    expiresAt: Math.floor(Date.now() / 1000) + LOGIN_ATTEMPT_TTL,
  };
}

export class LoginError extends Error {}

/** Exchanges the authorization code of a callback for the user's identity. */
export async function finishLogin(
  config: AppConfig,
  env: Bindings,
  callbackUrl: URL,
  attempt: { state: string; codeVerifier: string; nonce: string },
): Promise<SignedInUser> {
  const as = await authorizationServer(config, env);
  const options = requestOptions(config, env);

  let params: URLSearchParams;
  try {
    params = oauth.validateAuthResponse(as, client(config), callbackUrl, attempt.state);
  } catch (error) {
    if (error instanceof oauth.AuthorizationResponseError) {
      const description = error.error_description ? `: ${error.error_description}` : '';
      throw new LoginError(`IdP がログインを完了しませんでした（${error.error}${description}）`);
    }
    throw error;
  }

  const tokenResponse = await oauth.authorizationCodeGrantRequest(
    as,
    client(config),
    oauth.ClientSecretBasic(config.clientSecret),
    params,
    config.redirectUri,
    attempt.codeVerifier,
    options,
  );
  const result = await oauth.processAuthorizationCodeResponse(as, client(config), tokenResponse, {
    expectedNonce: attempt.nonce,
    requireIdToken: true,
  });
  await oauth.validateApplicationLevelSignature(as, tokenResponse, options);
  const claims = oauth.getValidatedIdTokenClaims(result);
  if (!claims || !result.id_token) throw new LoginError('ID Token が返されませんでした。');

  // The profile and email claims come from the UserInfo endpoint
  // (OIDC Core 1.0 §5.3); the ID Token is only sure to carry sub.
  let name = typeof claims.name === 'string' ? claims.name : null;
  let email = typeof claims.email === 'string' ? claims.email : null;
  if (as.userinfo_endpoint) {
    const userInfoResponse = await oauth.userInfoRequest(as, client(config), result.access_token, options);
    const userInfo = await oauth.processUserInfoResponse(as, client(config), claims.sub, userInfoResponse);
    name = (typeof userInfo.name === 'string' && userInfo.name) || (typeof userInfo.preferred_username === 'string' && userInfo.preferred_username) || name;
    email = (typeof userInfo.email === 'string' && userInfo.email) || email;
  }
  return { sub: claims.sub, name, email, idToken: result.id_token };
}

/** Where to send the browser to end the IdP session too (RP-Initiated Logout 1.0 §2). */
export async function endSessionUrl(config: AppConfig, env: Bindings, idToken: string | null): Promise<string | null> {
  let as: oauth.AuthorizationServer;
  try {
    as = await authorizationServer(config, env);
  } catch {
    return null;
  }
  if (!as.end_session_endpoint) return null;
  const url = new URL(as.end_session_endpoint);
  if (idToken) url.searchParams.set('id_token_hint', idToken);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('post_logout_redirect_uri', config.postLogoutRedirectUri);
  return url.href;
}
