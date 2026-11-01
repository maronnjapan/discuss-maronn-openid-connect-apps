/**
 * What the introspection endpoint answers, and the failure a step answers with
 * a fixed response.
 */

/** What the introspection endpoint answers; respondIntrospection() turns it into HTTP. */
export interface IntrospectionEndpointResponse {
  status: number;
  /** A JSON body (application/json). */
  body?: object;
  /** A raw body with its own Content-Type (the signed JWT of RFC 9701). */
  text?: string;
  headers?: Record<string, string>;
}

/** A failure a step answers with a fixed response (a malformed request). */
export class IntrospectionEndpointError extends Error {
  constructor(readonly response: IntrospectionEndpointResponse) {
    const details = (response.body ?? {}) as { error?: unknown; error_description?: unknown };
    super(String(details.error_description ?? details.error ?? 'introspection endpoint error'));
    this.name = 'IntrospectionEndpointError';
  }
}
