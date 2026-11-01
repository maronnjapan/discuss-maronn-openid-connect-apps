import { type AuthorizationOutcome, type AuthorizationRequestInput, isAuthorizationRequestParams } from '../outcome.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'parse-request',
  endpoint: 'authorize',
  kind: 'parse',
  label: 'Parse the authorization request',
  spec: 'OIDC Core 1.0 §3.1.2.1 / §13.2',
  function: 'parseAuthorizationRequest',
  consumes: [],
  produces: ['params'],
  removable: false,
});

/**
 * Iterates URLSearchParams and reports the first repeated key, if any.
 * OIDC Core 1.0 §3.1.2.1 / RFC 6749 §3.1: authorization request parameters
 * MUST NOT be repeated. Object.fromEntries(searchParams) silently keeps the
 * last value, which would let `response_type=code&response_type=token` slip
 * through, so we scan entries explicitly.
 */
function collectUniqueParams(
  searchParams: URLSearchParams,
): { params: Record<string, string>; duplicateKey?: string } {
  const params: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [key, value] of searchParams) {
    if (seen.has(key)) {
      return { params, duplicateKey: key };
    }
    seen.add(key);
    params[key] = value;
  }
  return { params };
}

/**
 * OIDC Core 1.0 Section 3.1.2.1 / Section 13.2: parses the authorization request
 * parameters from either GET (query string) or POST (application/x-www-form-urlencoded).
 * Returns null if the request transport is invalid (e.g. unsupported Content-Type on POST).
 */
async function parseAuthorizationRequestParams(
  c: any,
): Promise<{ params: Record<string, string>; duplicateKey?: string } | null> {
  if (c.req.method === 'POST') {
    const contentType = c.req.header('Content-Type') ?? '';
    // OIDC Core 1.0 Section 13.2: POST must use application/x-www-form-urlencoded.
    if (!contentType.toLowerCase().split(';')[0].trim().startsWith('application/x-www-form-urlencoded')) {
      return null;
    }
    // Read the raw body so URLSearchParams preserves duplicate keys
    // (parseBody silently dedupes them).
    const raw = await c.req.text();
    return collectUniqueParams(new URLSearchParams(raw));
  }
  return collectUniqueParams(new URL(c.req.url).searchParams);
}

/**
 * Parse the authorization request (GET query or POST form).
 * OIDC Core 1.0 §3.1.2.1 / §13.2 / RFC 6749 §3.1
 *
 * Returns the bad_request outcome for malformed transport: a POST that is not
 * application/x-www-form-urlencoded, a repeated parameter, or no client_id.
 * There is no transaction yet, so those are answered as OAuth error JSON.
 */
export async function parseAuthorizationRequest(
  c: any,
): Promise<{ params: AuthorizationRequestInput } | AuthorizationOutcome> {
  const parsed = await parseAuthorizationRequestParams(c);

  if (parsed === null) {
    return { kind: 'bad_request', error: 'invalid_request', errorDescription: 'Authorization POST requests must use application/x-www-form-urlencoded' };
  }

  // OIDC Core 1.0 §3.1.2.1 / RFC 6749 §3.1: request parameters MUST NOT be repeated.
  if (parsed.duplicateKey !== undefined) {
    return { kind: 'bad_request', error: 'invalid_request', errorDescription: `Parameter "${parsed.duplicateKey}" must not be repeated` };
  }

  const rawParams = parsed.params;

  if (!isAuthorizationRequestParams(rawParams)) {
    return { kind: 'bad_request', error: 'invalid_request', errorDescription: 'Missing required parameter: client_id' };
  }

  return { params: rawParams };
}
