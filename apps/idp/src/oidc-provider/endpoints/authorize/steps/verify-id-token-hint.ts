import {
  type AuthTransaction,
  validateIdTokenHint,
  IdTokenHintError,
  type JwkSet,
} from '@maronn-openid-connect/core';
import { type AuthorizationOutcome, buildErrorResponse } from '../outcome.js';
import type { AuthorizationResponseMode } from '../response-mode.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'verify-id-token-hint',
  endpoint: 'authorize',
  kind: 'validate',
  label: 'Verify id_token_hint',
  spec: 'OIDC Core 1.0 §3.1.2.1',
  function: 'verifyIdTokenHint',
  calls: ['validateIdTokenHint'],
  consumes: ['transactionId', 'transaction', 'issuer', 'responseMode'],
  optional: ['responseMode'],
  produces: ['verifiedHintSubject'],
  removable: true,
  fallback: true,
});

/**
 * Verify id_token_hint: signature, iss, aud, exp and iat against the OP's own
 * JWKS. OIDC Core 1.0 §3.1.2.1
 *
 * The rule ("if the End-User identified by the ID Token is logged in ...
 * otherwise it SHOULD return an error") is NOT conditioned on prompt, so the
 * hint is verified on every prompt path (no prompt / login / consent /
 * select_account / none). The verified subject is shared by the prompt=none
 * check and by the SSO fast path, so an unverified hint never reaches a
 * session decision. A hint that does not verify is a redirectable error
 * (login_required, or the hint's own code), and the transaction is dropped.
 */
export async function verifyIdTokenHint(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
  issuer: string,
  responseMode: AuthorizationResponseMode | undefined,
): Promise<{ verifiedHintSubject: string | undefined } | AuthorizationOutcome> {
  if (transaction.idTokenHint === undefined) return { verifiedHintSubject: undefined };
  const transactionStore = c.get('transactionStore');
  const jwksProvider = c.get('jwksProvider') as undefined | (() => Promise<JwkSet> | JwkSet);
  if (!jwksProvider) {
    // jwksProvider 未提供では hint を検証できない → login_required で拒否
    await transactionStore.delete('auth_txn:' + transactionId);
    return {
      kind: 'authorization_response',
      response: await buildErrorResponse(responseMode, transaction.redirectUri, 'login_required', transaction.state, 'jwksProvider is not configured; cannot verify id_token_hint', issuer),
    };
  }
  try {
    const jwks = await jwksProvider();
    const verified = await validateIdTokenHint(transaction.idTokenHint, {
      expectedIss: issuer,
      expectedAud: transaction.clientId,
      jwks,
    });
    return { verifiedHintSubject: verified.sub };
  } catch (hintError) {
    await transactionStore.delete('auth_txn:' + transactionId);
    const code = hintError instanceof IdTokenHintError ? hintError.error : 'login_required';
    return {
      kind: 'authorization_response',
      response: await buildErrorResponse(responseMode, transaction.redirectUri, code, transaction.state, hintError instanceof Error && hintError.message ? hintError.message : 'id_token_hint verification failed', issuer),
    };
  }
}
