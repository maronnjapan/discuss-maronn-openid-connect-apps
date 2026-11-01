/**
 * CORS for the endpoints browser-based clients call (OAuth 2.1 §4.2): the
 * token endpoint, UserInfo, the protected endpoints of the features, and the
 * metadata documents (discovery, JWKS).
 *
 * Written against the request context the endpoints use (c.req, c.header,
 * c.body), so the same middleware runs on Hono and on the WebRouter of the
 * Express and Fastify output.
 */
import type { CorsOrigins } from './app.js';

export interface CorsOptions {
  /** '*' answers every origin; a string or a list answers only those origins. */
  origins: CorsOrigins;
  allowMethods: readonly string[];
  allowHeaders: readonly string[];
  /** Seconds a browser may cache the preflight answer. */
  maxAge: number;
}

/** The Access-Control-Allow-Origin value for the origin of a request, or undefined to send none. */
export function resolveCorsOrigin(requestOrigin: string | null, allowed: CorsOrigins): string | undefined {
  if (allowed === '*') return '*';
  if (typeof allowed === 'string') return allowed;
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  return undefined;
}

/**
 * A middleware that adds the CORS headers to every answer of its path and
 * answers the preflight (OPTIONS) itself with 204.
 */
export function createCorsMiddleware(options: CorsOptions) {
  return async (c: any, next: () => Promise<unknown>): Promise<Response | void> => {
    const origin = resolveCorsOrigin(c.req.header('Origin') ?? null, options.origins);
    if (origin) {
      c.header('Access-Control-Allow-Origin', origin);
    }
    c.header('Vary', 'Origin');
    c.header('Access-Control-Allow-Methods', options.allowMethods.join(','));
    c.header('Access-Control-Allow-Headers', options.allowHeaders.join(','));
    c.header('Access-Control-Max-Age', String(options.maxAge));

    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204);
    }
    await next();
  };
}
