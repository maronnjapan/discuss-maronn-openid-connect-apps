import { RevocationEndpointError } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'parse-request',
  endpoint: 'revocation',
  feature: 'revocation',
  kind: 'parse',
  label: 'Parse the revocation request',
  spec: 'RFC 7009 §2.1',
  function: 'parseRevocationRequest',
  consumes: [],
  produces: ['params', 'authorization'],
  removable: false,
});

function isFormUrlEncoded(contentType: string): boolean {
  return contentType.toLowerCase().split(';')[0]?.trim() === 'application/x-www-form-urlencoded';
}

/**
 * Parse the revocation request: the form body and the Authorization header.
 * RFC 7009 §2.1 (the body MUST be application/x-www-form-urlencoded)
 */
export async function parseRevocationRequest(
  c: any,
): Promise<{ params: Record<string, string>; authorization: string }> {
  if (!isFormUrlEncoded(c.req.header('Content-Type') ?? '')) {
    throw new RevocationEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: 'Content-Type must be application/x-www-form-urlencoded' },
    });
  }
  const body = Object.fromEntries(new URLSearchParams(await c.req.text()));
  const authorization = c.req.header('Authorization') ?? '';
  const params = Object.fromEntries(
    Object.entries(body).map(([k, v]) => [k, String(v)]),
  );
  return { params, authorization };
}
