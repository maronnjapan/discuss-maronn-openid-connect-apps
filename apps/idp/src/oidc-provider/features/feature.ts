/**
 * What a feature can add to the provider.
 *
 * Each directory under features/ is one feature, and its feature.ts describes
 * it with defineFeature(): the routes it serves, the discovery metadata it
 * advertises, the values it puts into the request context, the defaults it
 * adds to the provider settings, the grants it answers at the token
 * endpoint, the response types it answers at /authorize besides code, the
 * response modes it restores at /consent and the login methods it shows on
 * the login page. These are the hooks; the rest of the provider reads them
 * through the functions below and never imports a feature.
 *
 * Logic that runs inside one of the provider's pipelines is not a hook: the
 * pipeline.ts of that endpoint calls the step of the feature in a block whose
 * marker line names it, `// [step-id] (feature: <id>) Label — Spec`.
 *
 * features/enabled.ts lists the features of this provider. Remove a feature
 * by deleting its directory, its lines there, the owner blocks that name it
 * in the pipelines (with their imports) and the lines of its steps in the
 * endpoint.ts files (with the edges to and from them).
 */
import type { Hono } from 'hono';
import type { OidcProviderOptions } from '../app.js';
import type { ProviderConfig } from '../config.js';
import type { AuthorizationResponseModeHandler } from '../endpoints/authorize/response-mode.js';
import type { AuthorizationResponseTypeHandler } from '../endpoints/authorize/response-type.js';
import type { LoginMethod } from '../endpoints/login/login-method.js';
import type { ProviderStores } from '../store.js';

/** An endpoint a feature serves, mounted by app.ts. */
export interface FeatureRoute {
  /** Where the app is mounted. */
  path: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any>;
  /** The HTTP methods of the path itself; any other one is answered with 405. */
  methods: readonly string[];
  /** The paths below the mount point the app also answers, with their methods. */
  subpaths?: Readonly<Record<string, readonly string[]>>;
  /**
   * 'protected': the CORS policy of the token endpoint (the origins of
   * OidcProviderOptions.corsOrigins). Leave it out for a browser-facing page.
   */
  cors?: 'protected';
}

/** What a context hook can read while the provider sets up a request. */
export interface FeatureContextInput {
  /** The request context, with every value the provider and the features before this one set. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any;
  options: OidcProviderOptions;
  stores: ProviderStores;
}

/**
 * The values a feature puts into the request context (c.set) for its own
 * steps. A function runs for every request; a value it returns under a name
 * the provider already set replaces that value.
 */
export type FeatureContext =
  | Readonly<Record<string, unknown>>
  | ((input: FeatureContextInput) => Record<string, unknown> | Promise<Record<string, unknown>>);

export interface Feature {
  /** The id of --enable / --disable. */
  readonly id: string;
  readonly routes?: readonly FeatureRoute[];
  /**
   * Members added to the provider metadata (OIDC Discovery 1.0 §3). An array
   * is merged with the array the provider already advertises under that name;
   * any other value replaces it.
   */
  readonly discovery?: (issuer: string, config: ProviderConfig) => Record<string, unknown>;
  readonly context?: FeatureContext;
  /** Defaults of the provider settings, applied over the defaults of config.ts. */
  readonly config?: Partial<ProviderConfig>;
  readonly token?: {
    /**
     * The grant_type values the feature answers at the token endpoint. The
     * token endpoint accepts them and discovery advertises them
     * (grant_types_supported).
     */
    readonly grants?: readonly string[];
  };
  readonly authorize?: {
    /**
     * Response modes the feature answers in. /consent restores the one the
     * authorization request asked for from the stored transaction.
     */
    readonly responseModes?: readonly AuthorizationResponseModeHandler[];
    /**
     * Response types the feature answers besides code (OIDC Core 1.0 §3):
     * validate-request accepts them, discovery advertises them
     * (response_types_supported), and the issue-authorization-code step of
     * /authorize hands an authenticated request of one of them (prompt=none,
     * or SSO with prior consent) to the handler instead of issuing a code.
     */
    readonly responseTypes?: readonly AuthorizationResponseTypeHandler[];
  };
  /** Ways to sign in that the login page offers next to the password form. */
  readonly loginMethods?: readonly LoginMethod[];
}

/** Describe a feature. The function only checks the shape; it returns its argument. */
export function defineFeature<const F extends Feature>(feature: F): F {
  return feature;
}

export function routesOf(features: readonly Feature[]): FeatureRoute[] {
  return features.flatMap((feature) => feature.routes ?? []);
}

/**
 * The provider metadata with the members of the features added: an array
 * member is merged (each value once, in order), any other member replaced.
 */
export function discoveryOf(
  features: readonly Feature[],
  metadata: Record<string, unknown>,
  issuer: string,
  config: ProviderConfig,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...metadata };
  for (const feature of features) {
    for (const [name, value] of Object.entries(feature.discovery?.(issuer, config) ?? {})) {
      const current = merged[name];
      merged[name] = Array.isArray(current) && Array.isArray(value)
        ? [...new Set([...current, ...value])]
        : value;
    }
  }
  return merged;
}

/** Put the context values of the features into the request context, in the order of the features. */
export async function applyContextOf(
  features: readonly Feature[],
  input: FeatureContextInput,
): Promise<void> {
  for (const feature of features) {
    const context = feature.context;
    if (context === undefined) continue;
    const values = typeof context === 'function' ? await context(input) : context;
    for (const [name, value] of Object.entries(values)) {
      input.c.set(name, value);
    }
  }
}

export function configOf(features: readonly Feature[]): Partial<ProviderConfig> {
  return Object.assign({}, ...features.map((feature) => feature.config ?? {}));
}

export function tokenGrantsOf(features: readonly Feature[]): string[] {
  // Two features may answer the same grant_type (token-exchange and id-jag
  // both read the token-exchange URN); it is listed once.
  return [...new Set(features.flatMap((feature) => feature.token?.grants ?? []))];
}

export function responseModesOf(features: readonly Feature[]): AuthorizationResponseModeHandler[] {
  return features.flatMap((feature) => feature.authorize?.responseModes ?? []);
}

export function responseTypesOf(features: readonly Feature[]): AuthorizationResponseTypeHandler[] {
  return features.flatMap((feature) => feature.authorize?.responseTypes ?? []);
}

export function loginMethodsOf(features: readonly Feature[]): LoginMethod[] {
  return features.flatMap((feature) => feature.loginMethods ?? []);
}
