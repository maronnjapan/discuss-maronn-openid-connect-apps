import type { AuthTransaction } from '@maronn-openid-connect/core';
import { buildClearedTransactionCookie } from '../../../cookies.js';
import {
  plainQueryResponse,
  restoreResponseMode,
  type ResponseModeTransaction,
} from '../../authorize/response-mode.js';
import type { ConsentOutcome } from '../screen.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'build-authorization-response',
  endpoint: 'consent',
  kind: 'transform',
  label: 'Build the authorization response',
  spec: 'RFC 9207 §2',
  function: 'buildConsentRedirect',
  calls: ['restoreResponseMode'],
  consumes: ['transaction', 'responseParams', 'authCodeData', 'issuer'],
  produces: ['outcome'],
  removable: false,
});

/**
 * [build-authorization-response] Build the authorization response for the
 * client, in the response mode the authorization request asked for. When the
 * authorize step recorded a response mode of a feature on the transaction
 * (JARM §2.3.1: the parameters signed into the single `response` query
 * parameter, whose iss claim carries the RFC 9207 statement; the Form Post
 * Response Mode: the parameters posted from an HTML form), that feature
 * restores it (restoreResponseMode() in endpoints/authorize/response-mode.ts).
 * Otherwise it is the plain query response, with RFC 9207 §2 iss appended so
 * clients can pin the issuer that produced it.
 */
export async function buildConsentRedirect(
  c: any,
  transaction: AuthTransaction,
  redirectUri: string,
  parameters: Record<string, string | undefined>,
  issuer: string,
): Promise<ConsentOutcome> {
  const responseMode = restoreResponseMode(c, transaction as ResponseModeTransaction);
  const response = responseMode
    ? await responseMode.respond(redirectUri, parameters)
    : plainQueryResponse(redirectUri, parameters, issuer);
  return { kind: 'authorization_response', response, cookies: [buildClearedTransactionCookie()] };
}
