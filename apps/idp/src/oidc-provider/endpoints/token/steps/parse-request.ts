import type { TokenRequestParams } from '@maronn-openid-connect/core';
import { type TokenRequestBody, TokenEndpointError } from '../response.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'parse-request',
  endpoint: 'token',
  kind: 'parse',
  label: 'Parse the token request',
  spec: 'RFC 6749 §4.1.3 / §3.2',
  function: 'parseTokenRequest',
  consumes: [],
  produces: ['params', 'authorization'],
  removable: false,
});

/**
 * Narrows raw body params to the typed TokenRequestParams.
 * Returns false when the required grant_type field is absent.
 */
function isTokenRequestParams(
  params: unknown,
): params is TokenRequestParams {
  if (typeof params !== 'object' || params === null) return false;
  const p = params as Record<string, unknown>;
  return typeof p['grant_type'] === 'string';
}

/**
 * Returns true when the Content-Type names application/x-www-form-urlencoded.
 * RFC 6749 §4.1.3 / Appendix B / OIDC Core 1.0 §3.1.3.1: the Token Request
 * entity-body MUST be application/x-www-form-urlencoded. Media types are
 * case-insensitive (RFC 9110 §8.3.1) and may carry parameters such as
 * "; charset=UTF-8", so we lowercase and strip everything after the first ';'.
 */
function isFormUrlEncoded(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/x-www-form-urlencoded';
}

/**
 * Parse the token request: the form body and the Authorization header.
 * RFC 6749 §4.1.3 / §3.2 / OIDC Core 1.0 §3.1.3.1
 *
 * Rejects (TokenEndpointError, 400 invalid_request) a body that is not
 * application/x-www-form-urlencoded, a repeated parameter and a missing
 * grant_type before anything is consumed as token parameters.
 */
export async function parseTokenRequest(
  c: any,
): Promise<{ params: TokenRequestBody; authorization: string }> {
  // RFC 6749 §4.1.3 / OIDC Core 1.0 §3.1.3.1: reject any body that is not
  // application/x-www-form-urlencoded (e.g. multipart/form-data, application/json)
  // before parsing so a non-form payload is never consumed as token parameters.
  const contentType = c.req.header('Content-Type') ?? '';
  if (!isFormUrlEncoded(contentType)) {
    throw new TokenEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: 'Token requests must use application/x-www-form-urlencoded' },
    });
  }

  // RFC 6749 §3.2: token endpoint request parameters MUST NOT be repeated.
  // Read the raw form body so URLSearchParams iteration exposes duplicate keys
  // instead of letting parseBody silently keep only the last value.
  const rawBody = await c.req.text();
  const searchParams = new URLSearchParams(rawBody);
  const rawParams: Record<string, string> = {};
  const seen = new Set<string>();
  let duplicateKey: string | undefined;
  for (const [key, value] of searchParams) {
    if (seen.has(key)) {
      duplicateKey = key;
      break;
    }
    seen.add(key);
    rawParams[key] = value;
  }
  const authorization = c.req.header('Authorization') ?? '';

  if (duplicateKey !== undefined) {
    throw new TokenEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: `Parameter "${duplicateKey}" must not be repeated` },
    });
  }

  if (!isTokenRequestParams(rawParams)) {
    throw new TokenEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: 'Missing required parameter: grant_type' },
    });
  }

  return { params: rawParams, authorization };
}
