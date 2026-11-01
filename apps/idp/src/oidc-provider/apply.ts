import type { Hono } from 'hono';
import { createApp, type OidcProviderOptions } from './app.js';

export type ApplyOidcOptions = OidcProviderOptions;

/**
 * Apply the OpenID Connect Provider routes and middleware to an existing Hono app.
 * Call this function to add OIDC provider functionality to your application.
 *
 * @example
 * import { Hono } from 'hono';
 * import { applyOidc } from './oidc-provider/apply.js';
 *
 * const app = new Hono();
 * app.get('/', (c) => c.text('Hello World'));
 * applyOidc(app, { signingKeyProvider: yourProvider });
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyOidc(app: Hono<any>, options: ApplyOidcOptions): void {
  app.route('/', createApp(options));
}
