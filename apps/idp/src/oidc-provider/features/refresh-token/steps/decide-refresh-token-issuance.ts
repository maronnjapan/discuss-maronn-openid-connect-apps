import {
  type TokenClientInfo,
  type ValidatedTokenRequest,
  clientAllowsRefreshTokenGrant,
} from '@maronn-openid-connect/core';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'decide-refresh-token-issuance',
  endpoint: 'token',
  feature: 'refresh-token',
  kind: 'decide',
  label: 'Decide whether a refresh token is issued',
  spec: 'OIDC Core 1.0 §11 / RFC 9700 §4.14',
  function: 'decideRefreshTokenIssuance',
  calls: ['clientAllowsRefreshTokenGrant'],
  consumes: ['tokenClient', 'validatedRequest'],
  produces: ['refreshTokenDecision'],
  removable: false,
});

/** Whether, and how, a refresh token is issued with this response. */
export interface RefreshTokenDecision {
  /** The grant holds offline_access: the refresh token outlives the login session. */
  grantHasOfflineAccess: boolean;
  /** The login session an online refresh token is bound to (undefined: not bound). */
  boundSessionId: string | undefined;
  /** Whether a refresh token is minted at all. */
  issueRefreshToken: boolean;
}

/**
 * Decide whether a refresh token is issued, and whether it is bound to the
 * login session (online) or outlives it (offline_access).
 * OIDC Core 1.0 §11 / RFC 9700 §4.14 / RFC 6749 §6
 */
export function decideRefreshTokenIssuance(
  c: any,
  tokenClient: TokenClientInfo,
  validatedRequest: ValidatedTokenRequest,
): RefreshTokenDecision {
  const config = c.get('config');

  // RFC 7591 §2 / OIDC Dynamic Client Registration 1.0 §2: grant_types の既定は
  // ["authorization_code"]。refresh_token を登録していないクライアントへ RT を渡しても、
  // 次に grant_type=refresh_token を出した瞬間 validateClientGrantType が
  // unauthorized_client で拒否する。一度も使えない長期資格情報を保存させるだけなので
  // （RFC 9700 §4.14）、登録が無ければ発行しない。
  const clientAllowsRefreshGrant = clientAllowsRefreshTokenGrant(tokenClient);

  // RFC 6749 §6 / OIDC Core 1.0 §11: refresh 時の scope 縮小は当該リクエストの access token /
  // ID Token の権限縮小として扱い、refresh token rotation の可否とは切り離す。rotation 可否は
  // 「元の grant が offline_access を持っていたか」で判断する。
  // - authorization_code grant: 今回付与された scope に offline_access があるか。
  // - refresh_token grant: 元 refresh token の grant が offline_access を持っていたか
  //   (validatedRequest.hadOfflineAccess)。縮小後 scope から offline_access を落としても
  //   元 grant の権限は失われないため rotation を継続する。
  const grantHasOfflineAccess =
    clientAllowsRefreshGrant &&
    (validatedRequest.grantType === 'refresh_token'
      ? validatedRequest.hadOfflineAccess
      : validatedRequest.scope.includes('offline_access'));

  // online refresh token の束縛先セッション。
  // OIDC Core 1.0 §11 は offline_access を「End-User が居ない（not logged in）ときにも
  // 使える Refresh Token」と定義したうえで、Refresh Token の利用がその用途に限られない
  // ことも明示している（"The Authorization Server MAY grant Refresh Tokens in other
  // contexts"）。この OP はその other contexts を online refresh token として実装し、
  // ログインセッションへ束縛する。offline_access がある grant は束縛しない。
  // - authorization_code grant: 認可コードが持つ sessionId（ログイン時に確立したもの）。
  // - refresh_token grant: 元 RT の束縛をそのまま引き継ぎ、rotation で外れないようにする。
  const boundSessionId = grantHasOfflineAccess ? undefined : validatedRequest.sessionId;

  // 束縛先が分からなければ online refresh token は発行しない。ブラウザセッションを
  // 持たない経路（device authorization grant）が該当する。ログアウトで止まる保証を
  // 付けられない RT を配らないための fail-closed。
  const issueRefreshToken =
    clientAllowsRefreshGrant &&
    (grantHasOfflineAccess ||
      (config.onlineRefreshTokenEnabled && boundSessionId !== undefined));

  return { grantHasOfflineAccess, boundSessionId, issueRefreshToken };
}
