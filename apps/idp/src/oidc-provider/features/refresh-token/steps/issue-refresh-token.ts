import {
  generateRandomString,
  type ValidatedTokenRequest,
  TokenError,
  TokenErrorCode,
} from '@maronn-openid-connect/core';
import type { RefreshTokenDecision } from './decide-refresh-token-issuance.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'issue-refresh-token',
  endpoint: 'token',
  feature: 'refresh-token',
  kind: 'issue',
  label: 'Mint and store the refresh token',
  spec: 'OAuth 2.1 §4.3.1 / §6.1',
  function: 'issueRefreshToken',
  calls: ['generateRandomString'],
  consumes: ['refreshTokenDecision', 'subject', 'authTime', 'nonce', 'validatedRequest', 'issuedAt', 'audience', 'acr', 'amr'],
  produces: ['refreshToken'],
  removable: false,
});

/**
 * Mint the refresh token the decision asked for and store its record for
 * rotation. Returns undefined when none is issued.
 * OAuth 2.1 §4.3.1 / §6.1 / OIDC Core 1.0 §12.1
 *
 * The same grantId / audience / authTime / nonce / acr / amr / azp is propagated
 * through rotations so descendants can be revoked on code reuse, the audience
 * never expands, and the ID Token a refresh re-issues keeps the values of the
 * first authentication (OIDC Core 1.0 §12.1).
 */
export async function issueRefreshToken(
  c: any,
  input: {
    decision: RefreshTokenDecision;
    subject: string;
    authTime: number | undefined;
    nonce: string | undefined;
    validatedRequest: ValidatedTokenRequest;
    issuedAt: number;
    audience: string[];
    acr: string | undefined;
    amr: string[] | undefined;
  },
): Promise<string | undefined> {
  const { decision, subject, authTime, nonce, validatedRequest, issuedAt, audience, acr, amr } = input;
  if (!decision.issueRefreshToken) return undefined;

  const refreshTokenStore = c.get('refreshTokenStore');
  const config = c.get('config');
  const refreshToken = generateRandomString(32);

  // authTime はここで必ず確定する: authorization_code 経由は authCode.authTime、
  // refresh_token 経由は validatedRequest.authTime。
  if (authTime === undefined) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'authTime is required to issue a refresh token',
    );
  }
  // OAuth 2.1 §6.1: refresh token は initial issuance からの absolute lifetime のみで失効する。
  // rotation を跨いで originalIssuedAt を引き継ぎ、expiresAt はそこからの絶対的な期限で固定する。
  // sliding expiry は持たないため、リフレッシュを繰り返しても失効時刻は前に進まず、
  // 漏洩 RT の長期 abuse を防ぐ。
  // - authorization_code grant: 今回が初回発行なので originalIssuedAt = issuedAt。
  // - refresh_token grant: 元 RT の originalIssuedAt をそのまま引き継ぐ。
  const originalIssuedAt =
    validatedRequest.grantType === 'refresh_token'
      ? validatedRequest.originalIssuedAt
      : issuedAt;
  const refreshTokenExpiresAt = originalIssuedAt + config.refreshTokenAbsoluteLifetime;
  // RFC 6749 §6: 縮小後 scope（validatedRequest.scope）から offline_access が落ちても、
  // grant が offline_access を持つ限り次回以降の rotation を継続できるよう、永続化する
  // refresh token の scope には offline_access を保持する。access token は
  // validatedRequest.scope をそのまま使うため、当該リクエストの権限は縮小されたままになる。
  const refreshTokenScope =
    decision.grantHasOfflineAccess && !validatedRequest.scope.includes('offline_access')
      ? [...validatedRequest.scope, 'offline_access']
      : validatedRequest.scope;
  await refreshTokenStore.set(refreshToken, {
    subject,
    clientId: validatedRequest.clientId,
    scope: refreshTokenScope,
    expiresAt: refreshTokenExpiresAt,
    originalIssuedAt,
    used: false,
    grantId: validatedRequest.grantId,
    iat: issuedAt,
    issuer: config.issuer,
    audience,
    authTime,
    nonce,
    // OIDC Core 1.0 §12.1: refresh で再発行する ID Token は初回認証時の acr / amr を保持する。
    // - authorization_code grant: resolveTokenAcrAmr() が決めた値をそのまま永続化する。
    // - refresh_token grant: 既に保存済みの値を引き継ぐ（resolver は呼ばれていない）。
    acr: validatedRequest.grantType === 'refresh_token' ? validatedRequest.acr : acr,
    amr: validatedRequest.grantType === 'refresh_token' ? validatedRequest.amr : amr,
    azp: validatedRequest.grantType === 'refresh_token' ? validatedRequest.azp : undefined,
    // online refresh token の束縛。undefined なら offline refresh token として
    // セッションから独立し、ログアウト後も使える。
    sessionId: decision.boundSessionId,
  });

  return refreshToken;
}
