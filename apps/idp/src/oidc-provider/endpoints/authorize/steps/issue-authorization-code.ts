import {
  type AuthTransaction,
  type SessionInfo,
  completeAuthTransaction,
  createAuthorizationCode,
} from '@maronn-openid-connect/core';
import { type AuthorizationOutcome, buildSuccessResponse } from '../outcome.js';
import type { AuthorizationResponseMode } from '../response-mode.js';
import { responseTypeHandlerOf } from '../response-type.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'issue-authorization-code',
  endpoint: 'authorize',
  kind: 'issue',
  label: 'Issue the authorization code and build the authorization response',
  spec: 'OIDC Core 1.0 §3.1.2.5 / RFC 9207 §2',
  function: 'issueAuthorizationCodeResponse',
  calls: ['responseTypeHandlerOf', 'completeAuthTransaction', 'createAuthorizationCode', 'consentResolver.recordGrant'],
  consumes: ['transactionId', 'transaction', 'session', 'issuer', 'responseMode'],
  optional: ['responseMode'],
  produces: [],
  removable: false,
  calledFrom: ['authenticate-silently', 'reuse-session'],
});

/**
 * Issue the authorization code for a session that needs no interaction
 * (prompt=none, or SSO with prior consent) and build the authorization
 * response. OIDC Core 1.0 §3.1.2.5 / §3.1.3.1 / RFC 9207 §2
 *
 * transaction.scope は認可リクエスト検証時に applyOfflineAccessPolicy を通した
 * 後の値。offline_access の可否（OIDC Core 1.0 §11 の prompt=consent と、
 * クライアント登録 grant_types に refresh_token があるか）はそこで判定済みなので、
 * ここで再フィルタしない。
 */
export async function issueAuthorizationCodeResponse(
  c: any,
  input: {
    transactionId: string;
    transaction: AuthTransaction;
    session: SessionInfo;
    issuer: string;
    responseMode: AuthorizationResponseMode | undefined;
  },
): Promise<AuthorizationOutcome> {
  const { transactionId, transaction, session, issuer, responseMode } = input;

  // A response type a feature answers (the Implicit Flow's id_token and
  // id_token token, OIDC Core 1.0 §3.2) returns its tokens in place of the
  // code: the authorize.responseTypes entry of that feature's feature.ts.
  const responseType = responseTypeHandlerOf(transaction.responseType);
  if (responseType) return responseType.respond(c, input);

  const transactionStore = c.get('transactionStore');
  const authCodeStore = c.get('authCodeStore');
  const consentResolver = c.get('consentResolver');
  const config = c.get('config');

  const grantedScope = transaction.scope.split(' ').filter(Boolean);

  // Generate authorization code via core helper
  const responseParams = await completeAuthTransaction(
    transactionId,
    transaction,
    transactionStore,
  );
  const authCodeData = await createAuthorizationCode({
    authorizationResponse: { ...responseParams, scope: grantedScope },
    subject: session.subject,
    authTime: session.authTime,
    // online refresh token をこのログインセッションへ束縛するために引き継ぐ。
    // セッションが終われば、その RT は invalid_grant になる。
    sessionId: session.sessionId,
    // OIDC Core 1.0 §3.1.3.1: TTL は ProviderConfig から設定可能（既定 300 秒）。
    ttlSeconds: config.authorizationCodeTtl,
  });
  await authCodeStore.set(authCodeData.code, authCodeData);
  await consentResolver?.recordGrant?.(
    session.subject,
    transaction.clientId,
    authCodeData.grantId,
  );

  return {
    kind: 'authorization_response',
    response: await buildSuccessResponse(
      responseMode, transaction.redirectUri,
      authCodeData.code,
      transaction.state,
      issuer,
    ),
  };
}
