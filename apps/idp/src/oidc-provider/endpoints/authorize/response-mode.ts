/**
 * How an authorization response travels back to the client.
 *
 * Every provider answers in the plain query response mode (RFC 6749 §4.1.2):
 * code, state and iss as query parameters of the redirect URI. A feature can
 * answer in a response mode of its own — JARM signs the parameters into one
 * JWT, the Form Post Response Mode posts them from an HTML form — by
 * producing an AuthorizationResponseMode in the authorization pipeline, and
 * restoring it at /consent through the authorize.responseModes entry of its
 * feature.ts.
 *
 * A response mode decides what the parameters look like and how the browser
 * carries them: in the URL it is redirected to, or in the body of a form it
 * posts. The pages turn either into HTTP (respondToClient() in
 * pages/authorization-response.tsx).
 */
import type { AuthTransaction } from '@maronn-openid-connect/core';
import { features } from '../../features/enabled.js';
import { responseModesOf } from '../../features/feature.js';

/** The parameters of an authorization response (RFC 6749 §4.1.2 / §4.1.2.1). */
export type AuthorizationResponseParameters = Record<string, string | undefined>;

/** An authorization response, as the browser carries it to the client. */
export type AuthorizationResponse =
  /** The browser is redirected to location, which carries the parameters. */
  | { method: 'redirect'; location: string }
  /**
   * OAuth 2.0 Form Post Response Mode §2: the OP answers with an HTML form
   * whose action is the redirect URI and whose method is POST, and the
   * browser submits it with the parameters as its fields.
   */
  | { method: 'form_post'; action: string; fields: Record<string, string> };

/** A response mode other than the plain query (undefined). */
export interface AuthorizationResponseMode {
  /** The response_mode value. It is stored on the transaction so /consent answers in the same mode. */
  readonly name: string;
  /** The authorization response that carries the parameters in this mode. */
  respond(redirectUri: string, parameters: AuthorizationResponseParameters): Promise<AuthorizationResponse>;
}

/** A response mode of a feature, as /consent restores it from the stored transaction. */
export interface AuthorizationResponseModeHandler {
  /** The names (AuthorizationResponseMode.name) it restores. */
  readonly names: readonly string[];
  restore(c: any, input: { name: string; clientId: string; issuer: string }): AuthorizationResponseMode;
}

/** The transaction as stored: the name of its response mode, when it is not the plain query. */
export type ResponseModeTransaction = AuthTransaction & { responseMode?: string };

/**
 * The response mode a stored transaction asked for, restored by the feature
 * that answers in it; undefined for the plain query response.
 *
 * @throws {Error} when the transaction names a response mode no enabled
 *   feature answers in (a configuration change while the transaction was
 *   open), which the endpoints answer with server_error.
 */
export function restoreResponseMode(
  c: any,
  transaction: ResponseModeTransaction,
): AuthorizationResponseMode | undefined {
  const name = transaction.responseMode;
  if (name === undefined) return undefined;
  const handler = responseModesOf(features).find((candidate) => candidate.names.includes(name));
  if (handler === undefined) {
    throw new Error(`No enabled feature answers in the response mode "${name}"`);
  }
  return handler.restore(c, { name, clientId: transaction.clientId, issuer: c.get('config').issuer });
}

/**
 * The plain query response (RFC 6749 §4.1.2 / §4.1.2.1): every parameter that
 * has a value in the query of the redirect URI, and iss (RFC 9207 §2) so the
 * client can pin the issuer that produced it.
 */
export function plainQueryResponse(
  redirectUri: string,
  parameters: AuthorizationResponseParameters,
  issuer: string,
): AuthorizationResponse {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(parameters)) {
    if (value) url.searchParams.set(name, value);
  }
  url.searchParams.set('iss', issuer);
  return { method: 'redirect', location: url.toString() };
}
