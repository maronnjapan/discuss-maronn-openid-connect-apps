/**
 * What the authorization endpoint returns for the response_type of a request.
 *
 * Every provider answers response_type=code with an authorization code (OIDC
 * Core 1.0 §3.1.2.5). A feature that answers other response types — the
 * Implicit Flow's id_token and id_token token (OIDC Core 1.0 §3.2), the
 * Hybrid Flow's code id_token, code token and code id_token token (§3.3) —
 * adds an AuthorizationResponseTypeHandler to the authorize.responseTypes entry of its
 * feature.ts: validate-request accepts its response types, discovery
 * advertises them, and the issue-authorization-code step hands an
 * authenticated request of one of them to the handler.
 *
 * Only the request that needs no screen (prompt=none, or SSO with prior
 * consent) reaches the handler: its code is issued inside the blocks of
 * authenticate-silently and reuse-session, where no block of a feature can
 * sit. /consent runs a block of the feature itself.
 */
import type { AuthorizationResponseType, AuthTransaction, SessionInfo } from '@maronn-openid-connect/core';
import { features } from '../../features/enabled.js';
import { responseTypesOf } from '../../features/feature.js';
import type { AuthorizationOutcome } from './outcome.js';
import type { AuthorizationResponseMode } from './response-mode.js';

/** An authenticated request that needs no screen, as issue-authorization-code hands it to a handler. */
export interface AuthorizationResponseInput {
  transactionId: string;
  transaction: AuthTransaction;
  session: SessionInfo;
  issuer: string;
  /** The response mode the request asked for; undefined for the default one of its response type. */
  responseMode: AuthorizationResponseMode | undefined;
}

/** A response type a feature answers besides code. */
export interface AuthorizationResponseTypeHandler {
  /** The response_type values it answers, as core's normalizeResponseType() writes them. */
  readonly names: readonly AuthorizationResponseType[];
  /**
   * Finish the transaction and answer the request with what the response type
   * returns, in place of the authorization code.
   */
  respond(c: any, input: AuthorizationResponseInput): Promise<AuthorizationOutcome>;
}

/** The response types the provider answers: code, and those of the features (response_types_supported). */
export function supportedResponseTypes(): AuthorizationResponseType[] {
  return ['code', ...responseTypesOf(features).flatMap((handler) => handler.names)];
}

/**
 * The handler of the feature that answers the response type of a validated
 * request; undefined for code, which the provider answers itself.
 */
export function responseTypeHandlerOf(responseType: string): AuthorizationResponseTypeHandler | undefined {
  return responseTypesOf(features).find((handler) => (handler.names as readonly string[]).includes(responseType));
}
