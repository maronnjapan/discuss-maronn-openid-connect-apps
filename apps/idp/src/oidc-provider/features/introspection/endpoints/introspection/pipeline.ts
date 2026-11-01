import { Hono } from 'hono';
import { authenticateIntrospectionClient } from './steps/authenticate-client.js';
import { describeIntrospectedToken } from './steps/build-response.js';
import { parseIntrospectionRequest } from './steps/parse-request.js';
import { resolveIntrospectedToken } from './steps/resolve-token.js';
import { respondIntrospectionError } from './steps/respond-error.js';
import { respondIntrospection } from './steps/respond.js';

/**
 * Token Introspection endpoint (API layer).
 * RFC 7662 Section 2
 *
 * Each block below calls one step (one box of
 * `maronn-oidc graph --detail steps --endpoint introspection`): parse the
 * request, authenticate the confidential client, resolve the token, describe
 * it, and answer. A step that throws ends in respondIntrospectionError().
 *
 * Confidential client only — a caller registered with
 * token_endpoint_auth_method 'none' is rejected with invalid_client
 * (RFC 7662 §2.1 / RFC 9701 §5), because a public client_id alone is not
 * authentication. Response is always cache-busting per RFC 7662 Section 2.2.
 */
export const introspectionApp = new Hono<{ Variables: Record<string, any> }>();

introspectionApp.post('/', async (c) => {
  try {
    // [parse-request] Parse the introspection request — RFC 7662 §2.1
    const { params, authorization } = await parseIntrospectionRequest(c);

    // [authenticate-client] Authenticate the confidential client — RFC 7662 §2.1 / OAuth 2.1 §2.3
    const authenticatedClientId = await authenticateIntrospectionClient(c, params, authorization);

    // [resolve-token] Resolve the presented token — RFC 7662 §2.1
    const resolved = await resolveIntrospectedToken(c, params, authenticatedClientId);

    // [build-response] Describe the token (active or not) — RFC 7662 §2.2
    const introspection = describeIntrospectedToken(resolved);

    // [respond] Respond (no-store) — RFC 7662 §2.2
    return respondIntrospection(c, { status: 200, body: introspection });
  } catch (error) {
    return respondIntrospectionError(c, error);
  }
});
