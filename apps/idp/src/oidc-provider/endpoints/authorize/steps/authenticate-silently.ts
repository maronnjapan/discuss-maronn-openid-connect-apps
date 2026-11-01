import {
  type AuthTransaction,
  AuthorizationError,
  resolvePromptNoneSession,
  validatePromptNoneIdTokenHint,
  validatePromptNoneConsent,
  requiresReauthentication,
  type SessionInfo,
} from '@maronn-openid-connect/core';
import { resolveGrantableScopes } from '../../../scopes.js';
import { type AuthorizationOutcome, buildErrorResponse } from '../outcome.js';
import type { AuthorizationResponseMode } from '../response-mode.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'authenticate-silently',
  endpoint: 'authorize',
  kind: 'dispatch',
  label: 'prompt=none: authenticate without interaction',
  spec: 'OIDC Core 1.0 §3.1.2.1',
  function: 'completePromptNoneRequest',
  calls: ['resolvePromptNoneSession', 'validatePromptNoneIdTokenHint', 'resolveGrantableScopes', 'validatePromptNoneConsent', 'requiresReauthentication'],
  consumes: ['promptValues', 'transactionId', 'transaction', 'verifiedHintSubject', 'issuer', 'responseMode'],
  optional: ['responseMode'],
  produces: ['session'],
  removable: true,
});

/**
 * prompt=none: silent authentication without any user interaction.
 * OIDC Core 1.0 §3.1.2.1
 *
 * Returns undefined when the request did not ask for prompt=none (the
 * pipeline goes on to SSO and the login screen). Otherwise the session the
 * code is issued for, or the redirectable error (login_required /
 * consent_required / server_error) and the transaction is dropped: the OP
 * must not show a login or consent screen for prompt=none.
 */
export async function completePromptNoneRequest(
  c: any,
  input: {
    promptValues: string[];
    transactionId: string;
    transaction: AuthTransaction;
    verifiedHintSubject: string | undefined;
    issuer: string;
    responseMode: AuthorizationResponseMode | undefined;
  },
): Promise<{ session: SessionInfo } | AuthorizationOutcome | undefined> {
  const { promptValues, transactionId, transaction, verifiedHintSubject, issuer, responseMode } = input;
  if (!promptValues.includes('none')) return undefined;

  const transactionStore = c.get('transactionStore');
  const sessionResolver = c.get('sessionResolver');
  const consentResolver = c.get('consentResolver');
  const errorResponse = async (error: string, description: string): Promise<AuthorizationOutcome> => {
    await transactionStore.delete('auth_txn:' + transactionId);
    return {
      kind: 'authorization_response',
      response: await buildErrorResponse(responseMode, transaction.redirectUri, error, transaction.state, description, issuer),
    };
  };

  // No sessionResolver configured → cannot verify session → login_required
  if (!sessionResolver) {
    return errorResponse('login_required', 'sessionResolver is not configured; cannot satisfy prompt=none');
  }

  // No consentResolver configured → cannot confirm consent → consent_required
  // (OIDC Core 1.0 Section 3.1.2.1: prompt=none must not display consent screen)
  if (!consentResolver) {
    return errorResponse('consent_required', 'consentResolver is not configured; cannot satisfy prompt=none');
  }

  let session: SessionInfo;
  try {
    // --- prompt=none pipeline ---------------------------------------
    // Each step below is an independent core function: the session, then
    // id_token_hint (before consent, so consent is never looked up for
    // another End-User), then consent. Delete a call to drop that check,
    // or insert your own logic between steps. Every step throws
    // AuthorizationError(login_required | consent_required) on failure.

    // OIDC Core 1.0 §3.1.2.1: no active session → login_required (the OP
    // must not show a login screen for prompt=none).
    session = await resolvePromptNoneSession(transaction, sessionResolver, c.req.raw);

    // verifiedHintSubject は上流（prompt 非依存の検証ブロック）で確定済み。
    // ここでは prompt=none 固有の「不一致なら login_required」判定だけを行う。
    // コンセント確認より前に置くのは、コンセント検索が session.subject をキーに
    // するため — 不一致のまま進むと別ユーザーのコンセントを見てしまう。
    validatePromptNoneIdTokenHint(transaction, session, verifiedHintSubject);

    // Apply the scope policy BEFORE the consent lookup: searching consent for
    // a scope this End-User can never hold would answer consent_required
    // forever (OIDC Core 1.0 §3.1.2.1). See resolveGrantableScopes() in
    // scopes.ts — that function is where per-user filtering is written.
    transaction.scope = (await resolveGrantableScopes(
      transaction.scope.split(' ').filter(Boolean),
      session.subject,
    )).join(' ');

    // OIDC Core 1.0 §3.1.2.1: not consented → consent_required (the OP must
    // not show a consent screen for prompt=none).
    await validatePromptNoneConsent(transaction, session, consentResolver);
  } catch (promptError) {
    if (promptError instanceof AuthorizationError) {
      return errorResponse(promptError.error, promptError.errorDescription ?? '');
    }
    const serverDescription =
      promptError instanceof Error && promptError.message
        ? promptError.message
        : 'Unexpected error while evaluating prompt=none';
    return errorResponse('server_error', serverDescription);
  }

  // Check max_age: if session is too old, prompt=none cannot trigger re-authentication
  // OIDC Core 1.0 Section 3.1.2.1
  if (transaction.maxAge !== undefined && requiresReauthentication(transaction.maxAge, session.authTime)) {
    return errorResponse('login_required', 'Session exceeds the requested max_age; re-authentication required');
  }

  return { session };
}
