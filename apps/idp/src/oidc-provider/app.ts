import { Hono } from 'hono';
import {
  assertHasRs256Key,
  assertKeyStrength,
  assertKidStrategyConsistent,
  signingKeysToJwkSet,
  type AcrResolver,
  type ClientKeyResolver,
  type ClientResolver,
  type ConsentResolver,
  type JwkSet,
  type SessionResolver,
  type SigningKey,
  type SigningKeyProvider,
  type TokenClientResolver,
} from '@maronn-openid-connect/core';
import { createProviderConfig, type ProviderConfig } from './config.js';
import { createCorsMiddleware } from './cors.js';
import {
  createClientKeyResolver,
  createClientResolver,
  createDatabase,
  createProviderStores,
} from './db/index.js';
import { authorizePage } from './endpoints/authorize/page.js';
import { consentPage } from './endpoints/consent/page.js';
import { discoveryApp } from './endpoints/discovery/pipeline.js';
import { jwksApp } from './endpoints/jwks/pipeline.js';
import { loginPage } from './endpoints/login/page.js';
import { tokenApp } from './endpoints/token/pipeline.js';
import { userinfoApp } from './endpoints/userinfo/pipeline.js';
import { features } from './features/enabled.js';
import { applyContextOf, routesOf, type FeatureRoute } from './features/feature.js';
import { createStoreResolvers } from './resolvers.js';
import type { ProviderStores, ProviderStoresFactory } from './store.js';
import { createViews, type Views } from './views.js';

/**
 * CORS の許可 origin。
 * - '*' (デフォルト) または string / string[]: createCorsMiddleware()（cors.ts）の origins に渡される
 * - browser-based クライアントで Authorization ヘッダや form body を使う場合は許可必須 (OAuth 2.1 §4.2)
 */
export type CorsOrigins = string | string[];

/**
 * The options of createApp() and applyOidc(). A feature adds the options it
 * takes to this interface from its directory (`declare module '../../app.js'`)
 * and reads them in its context hook.
 */
export interface OidcProviderOptions {
  config?: Partial<ProviderConfig>;
  /**
   * Primary signing key provider. getSigningKeys() returns the registered
   * keys: the first one signs access tokens (JWT format), and every one is
   * published at the JWKS endpoint, so keep a rotated-out key after the new one
   * until the tokens it signed expire. Also used for ID Token / UserInfo
   * signing when their dedicated providers are not configured.
   * Must load keys from your secret store (env var, KV, D1, etc.).
   * Use createCachedSigningKeyProvider() to refresh the keys periodically.
   */
  signingKeyProvider: SigningKeyProvider;
  /**
   * Optional ID Token signing key provider.
   * If omitted, signingKeyProvider is used.
   * Useful when id_token_signed_response_alg differs from the access token
   * algorithm, or when you want to rotate ID Token keys independently.
   */
  idTokenSigningKeyProvider?: SigningKeyProvider;
  /**
   * Optional UserInfo JWT signing key provider.
   * If omitted, signingKeyProvider is used.
   * Useful when userinfo_signed_response_alg differs from other signing keys
   * (OIDC Core 1.0 Section 5.3.2).
   */
  userinfoSigningKeyProvider?: SigningKeyProvider;
  /** Clients to use instead of the clients of db/ (registerClient() in db/clients.ts). */
  clientResolver?: ClientResolver;
  tokenClientResolver?: TokenClientResolver;
  /**
   * The public keys each client registered, one purpose at a time
   * (ClientKeyResolver in core). The OP verifies signed Request Objects with
   * the keys of request_object.
   * Defaults to the keys registerClient() put into db/, read for each request.
   */
  clientKeyResolver?: ClientKeyResolver;
  /**
   * Session resolver used for SSO / prompt=none / max_age
   * (OIDC Core 1.0 Section 3.1.2.1 / 3.1.2.3).
   * Defaults to the cookie-based browser session resolver in resolvers.ts.
   */
  sessionResolver?: SessionResolver;
  /**
   * Consent resolver used by prompt=none to confirm prior consent without UI
   * (OIDC Core 1.0 Section 3.1.2.1).
   * Defaults to the consent store resolver in resolvers.ts.
   */
  consentResolver?: ConsentResolver;
  /** Stores to use instead of db/: the stores on the database createDatabase() (db/) returns for each request. */
  storage?: ProviderStores | ProviderStoresFactory;
  /**
   * acr / amr of the tokens (OIDC Core 1.0 §2 / §3.1.2.1 / RFC 9068 §2.2.1):
   * return the acr / amr your login satisfied for the acr values the client
   * requested. The ID Token carries both and the access token the acr.
   * Omit it to put the most preferred requested acr value (acr_values) into
   * both tokens, without amr (the resolve-acr-amr step of endpoints/token/).
   */
  acrResolver?: AcrResolver;
  /**
   * JWKS provider used to verify id_token_hint (OIDC Core 1.0 §3.1.2.2).
   * Omit to use the OP's own ID Token signing keys by default, so an ID Token
   * the OP issued can be presented back as id_token_hint without extra wiring.
   * Override only when hints are signed by a different key set.
   */
  jwksProvider?: () => Promise<JwkSet> | JwkSet;
  /**
   * CORS で許可する origin。
   * - 未指定: '*' (=ワイルドカード)
   * - 文字列または配列: そのまま createCorsMiddleware()（cors.ts）の origins に渡す
   *
   * Token / UserInfo と、機能が protected として登録したエンドポイントに適用される。
   * Discovery / JWKS は仕様上常に '*' 固定 (OIDC Discovery / RFC 8414 で公開資産扱い)。
   */
  corsOrigins?: CorsOrigins;
  /**
   * Custom UI for the login / consent / error pages, and for the screens of
   * the features. Provide any subset; omitted pages fall back to the default
   * views. Inject your own UI here instead of editing views.tsx.
   */
  views?: Partial<Views>;
}

export function validateSigningKeySet(
  keys: readonly SigningKey[],
  requireRs256 = false,
): void {
  // The first key of a set signs new tokens, so a set needs at least one key.
  if (keys.length === 0) {
    throw new Error('Signing key set must contain at least one key');
  }
  assertKeyStrength(keys);
  assertKidStrategyConsistent(keys);
  if (requireRs256) {
    assertHasRs256Key(keys.map((key) => key.privateKey));
  }
}

/**
 * The endpoints every provider has. The features add theirs
 * (routesOf(features)), and app.ts mounts both the same way.
 */
const baseRoutes: readonly FeatureRoute[] = [
  { path: '/authorize', app: authorizePage, methods: ['GET', 'POST'] },
  { path: '/token', app: tokenApp, methods: ['POST'], cors: 'protected' },
  { path: '/userinfo', app: userinfoApp, methods: ['GET', 'POST'], cors: 'protected' },
  { path: '/.well-known/jwks.json', app: jwksApp, methods: ['GET'] },
  { path: '/.well-known/openid-configuration', app: discoveryApp, methods: ['GET'] },
  { path: '/login', app: loginPage, methods: ['GET', 'POST'] },
  { path: '/consent', app: consentPage, methods: ['GET', 'POST'] },
];

/**
 * The paths the provider serves: the endpoints of every provider and those of
 * the features of features/enabled.ts. The apply.ts of Express and Fastify
 * hands these paths to the provider.
 */
export function providerRoutes(): FeatureRoute[] {
  return [...baseRoutes, ...routesOf(features)];
}

/** Discovery and JWKS are public documents (OIDC Discovery 1.0 / RFC 8414): CORS '*'. */
const PUBLIC_DOCUMENT_PATHS = ['/.well-known/openid-configuration', '/.well-known/jwks.json'];

/** The HTTP methods of every path the provider answers, for the 405 guard. */
function endpointMethods(routes: readonly FeatureRoute[]): Map<string, readonly string[]> {
  const methods = new Map<string, readonly string[]>();
  for (const route of routes) {
    methods.set(route.path, route.methods);
    for (const [subpath, subpathMethods] of Object.entries(route.subpaths ?? {})) {
      methods.set(route.path + subpath, subpathMethods);
    }
  }
  return methods;
}

/**
 * Initialize the OpenID Connect Provider: a router with its middleware and its
 * endpoints (a Hono app; in the Express and Fastify output, the WebRouter of
 * web-router.ts). On Hono, mount it with app.route('/', createApp(options));
 * on Express and Fastify, call applyOidc() (apply.ts).
 */
export function createApp(options: OidcProviderOptions): Hono<{ Variables: Record<string, any> }> {
  // A factory must return an isolated router each time. Keeping this instance at
  // module scope makes later createApp calls reuse a matcher whose routes were
  // already finalized and also leaks the first call's middleware/options.
  const app = new Hono<{ Variables: Record<string, any> }>();
  const routes = providerRoutes();
  const methods = endpointMethods(routes);

  // CORS middleware (OAuth 2.1 §4.2): browser-based clients call the token,
  // UserInfo and the protected feature endpoints with Access-Control-Allow-Origin.
  // Preflight (OPTIONS) requests are answered here too.
  const protectedCors = createCorsMiddleware({
    origins: options.corsOrigins ?? '*',
    allowMethods: ['POST', 'GET', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  });
  const publicCors = createCorsMiddleware({
    origins: '*',
    allowMethods: ['GET', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    maxAge: 600,
  });
  for (const route of routes) {
    if (route.cors === 'protected') app.use(route.path, protectedCors);
  }
  for (const path of PUBLIC_DOCUMENT_PATHS) app.use(path, publicCors);

  // CORS must run first so OPTIONS preflights are answered before method enforcement.
  // The middleware runs on the provider's paths only (`/x/*` matches /x and
  // the paths below it), so a route the host app adds after applyOidc() is
  // left to the app.
  const enforceMethods = async (c: any, next: () => Promise<unknown>): Promise<Response | void> => {
    const allowed = methods.get(new URL(c.req.url).pathname);
    const method = c.req.method;
    // RFC 9110 §9.1: general-purpose servers MUST support HEAD wherever GET is
    // supported. HEAD shares GET semantics (§9.3.2), so let it through on any
    // GET-allowing endpoint; the router runs the GET handler and strips the body.
    const isHeadOnGet = method === 'HEAD' && (allowed?.includes('GET') ?? false);
    if (allowed && !allowed.includes(method) && !isHeadOnGet) {
      c.header('Allow', allowed.join(', '));
      return c.body(null, 405);
    }
    await next();
  };

  // Store runtime dependencies for use by the endpoints.
  const storeContext = async (c: any, next: () => Promise<unknown>): Promise<Response | void> => {
    const failure = await setRequestContext(c, options);
    if (failure) return failure;
    await next();
  };

  // A path below another provider path (/login/google below /login) is
  // covered by the middleware of that path already.
  const mountPaths = routes
    .map((route) => route.path)
    .filter((path) => !routes.some((other) => path.startsWith(`${other.path}/`)));
  for (const path of mountPaths) app.use(`${path}/*`, enforceMethods);
  for (const path of mountPaths) app.use(`${path}/*`, storeContext);

  for (const route of routes) app.route(route.path, route.app);
  return app;
}

/**
 * Put what the endpoints read into the request context (c.set): the
 * settings, the signing keys, the stores and resolvers of db/, and the values
 * of the features' context hooks. Returns the response to answer instead
 * when the signing keys cannot be loaded.
 */
export async function setRequestContext(c: any, options: OidcProviderOptions): Promise<Response | undefined> {
  // T-022: each provider returns its registered key set. The first key of a
  // set signs new tokens, and every key is published at the JWKS endpoint so
  // rotated-out and alternate-alg keys stay verifiable.
  let signingKeys: SigningKey[];
  let idTokenSigningKeys: SigningKey[];
  let userinfoSigningKeys: SigningKey[];
  try {
    signingKeys = await options.signingKeyProvider.getSigningKeys();
    // Each purpose-specific provider falls back to the primary one.
    const idProvider = options.idTokenSigningKeyProvider ?? options.signingKeyProvider;
    idTokenSigningKeys = await idProvider.getSigningKeys();
    const uiProvider = options.userinfoSigningKeyProvider ?? options.signingKeyProvider;
    userinfoSigningKeys = await uiProvider.getSigningKeys();
    validateSigningKeySet(signingKeys);
    validateSigningKeySet(idTokenSigningKeys, true);
    validateSigningKeySet(userinfoSigningKeys);
  } catch {
    return c.json({ error: 'server_error', error_description: 'Failed to load signing key' }, 503);
  }
  const stores = await resolveProviderStores(options.storage, c);
  const storeResolvers = createStoreResolvers(stores);
  const clientResolver = options.clientResolver ?? createClientResolver(createDatabase(c));

  // T-022: registered key sets per purpose.
  c.set('signingKeys', signingKeys);
  c.set('idTokenSigningKeys', idTokenSigningKeys);
  c.set('userinfoSigningKeys', userinfoSigningKeys);

  c.set('config', createProviderConfig(options.config));
  c.set('clientResolver', clientResolver);
  c.set('tokenClientResolver', options.tokenClientResolver ?? clientResolver);
  c.set('clientKeyResolver', options.clientKeyResolver ?? createClientKeyResolver(createDatabase(c)));
  c.set('stores', stores);
  c.set('transactionStore', stores.transactionStore);
  c.set('authCodeStore', stores.authCodeStore);
  c.set('accessTokenStore', stores.accessTokenStore);
  c.set('refreshTokenStore', stores.refreshTokenStore);
  c.set('authSessionStore', stores.authSessionStore);
  c.set('browserSessionStore', stores.browserSessionStore);
  c.set('userStore', stores.userStore);
  c.set('authenticateUser', (username: string, password: string) =>
    stores.userStore.authenticate(username, password));
  c.set('authCodeResolver', storeResolvers.authorizationCodeResolver);
  c.set('accessTokenResolver', storeResolvers.accessTokenResolver);
  c.set('userClaimsResolver', storeResolvers.userClaimsResolver);
  c.set('refreshTokenResolver', storeResolvers.refreshTokenResolver);
  c.set('authenticationSessionResolver', storeResolvers.authenticationSessionResolver);
  c.set('revokeConsentAndTokens', storeResolvers.revokeConsentAndTokens);

  // T-015: acr / amr resolver (optional; without one, the token endpoint puts
  // the most preferred requested acr value into the tokens).
  if (options.acrResolver) {
    c.set('acrResolver', options.acrResolver);
  }
  // T-017 / P1: id_token_hint 検証用 JWKS プロバイダ。未指定なら OP 自身の
  // ID Token 署名鍵セットを既定として使い、OP が発行した ID Token を hint として
  // 検証できるようにする（OIDC Core 1.0 §3.1.2.2）。明示指定があれば優先。
  c.set('jwksProvider', options.jwksProvider ?? (() => signingKeysToJwkSet(idTokenSigningKeys)));
  // P1: default cookie-based session + consent resolvers so prompt=none /
  // max_age / SSO work out of the box (OIDC Core 1.0 Section 3.1.2.1 / 3.1.2.3).
  c.set('sessionResolver', options.sessionResolver ?? storeResolvers.sessionResolver);
  c.set('consentResolver', options.consentResolver ?? storeResolvers.consentResolver);
  // Inject custom UI (login / consent / error, and the screens of the
  // features) merged over the defaults.
  c.set('views', createViews(options.views));

  // What the features add for their own steps, in the order of
  // features/enabled.ts.
  await applyContextOf(features, { c, options, stores });
  return undefined;
}

async function resolveProviderStores(
  storage: OidcProviderOptions['storage'],
  context: any,
): Promise<ProviderStores> {
  if (!storage) return createProviderStores(createDatabase(context));
  return typeof storage === 'function' ? storage(context) : storage;
}
