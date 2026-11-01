import type {
  ClientInfo,
  ClientKeysByPurpose,
  TokenClientInfo,
} from '@maronn-openid-connect/core';
import { configOf } from './features/feature.js';
import { features } from './features/enabled.js';

/**
 * The settings of the provider.
 *
 * The fields below are the ones every generated provider has. A feature that
 * needs a setting of its own adds it to this interface from its directory
 * (`declare module '../../config.js'` in features/<id>/), and its default from
 * the config entry of its feature.ts. Removing the feature removes both.
 */
export interface ProviderConfig {
  issuer: string;
  accessTokenExpiresIn: number;
  idTokenExpiresIn: number;
  /**
   * Refresh token の absolute lifetime（秒）。初回発行時刻からの絶対的な有効期限。
   * OAuth 2.1 §6.1: refresh token rotation で sliding expiry を毎回延長すると、利用者が
   * リフレッシュし続ける限り RT が無期限に延び、漏洩 RT が長期間 abuse され得る。本実装は
   * sliding expiry を持たず、RT の expiresAt は initial issuance（originalIssuedAt）からの
   * この absolute lifetime のみで決まる。rotation しても失効時刻は前に進まない。
   * 設定例: 90 日 = 7776000。
   */
  refreshTokenAbsoluteLifetime: number;
  /**
   * online refresh token（`offline_access` が付与されていない grant にも発行する
   * Refresh Token）を有効にするか。
   *
   * OIDC Core 1.0 §11 は `offline_access` を「End-User が居ない（not logged in）ときにも
   * 使える Refresh Token」と定義したうえで、Refresh Token の利用がその用途に限られない
   * ことを明示している（"The use of Refresh Tokens is not exclusive to the
   * `offline_access` use case. The Authorization Server MAY grant Refresh Tokens in
   * other contexts that are beyond the scope of this specification."）。本 OP はその
   * 「other contexts」を online refresh token として実装する。
   *
   * - `true`（既定）: `grant_types` に `refresh_token` を登録したクライアントには、
   *   `offline_access` が無くても Refresh Token を発行する。ただし発行元のログイン
   *   セッションへ束縛され、セッションが終われば `invalid_grant` になる。ブラウザ
   *   セッションを持たない経路（device authorization grant）では発行しない。
   * - `false`: Refresh Token は `offline_access` が付与された grant にだけ発行する。
   *   ログアウトしても使い続けられる offline refresh token だけになる。
   */
  onlineRefreshTokenEnabled: boolean;
  /**
   * アクセストークンの形式。
   * - 'jwt' (デフォルト): 自己完結。ステートレス検証可能だが即時失効が困難。
   * - 'opaque'         : 不透明文字列。リソースサーバは Introspection / ストア参照で検証。
   *                      Revocation との相性が良く、即時失効が必要なケースに向く。
   */
  accessTokenFormat: 'jwt' | 'opaque';
  /**
   * Authorization code の有効期間（秒）。OIDC Core 1.0 §3.1.3.1 は authorization code を
   * short-lived にすることを求めており（推奨上限 10 分）、本ライブラリは core helper の
   * デフォルトと同じ 300 秒（5 分）を既定値とする。PoC でタイムアウト挙動を確認したい場合は
   * この値を縮めて検証できる。
   */
  authorizationCodeTtl: number;
  /**
   * OpenID Foundation Basic OP static-client conformance 互換モード。
   * true の場合、core は明示的な confidential client の完全な非 PKCE request だけを
   * 許可し、不正な PKCE 値や public client の非 PKCE request は拒否する。
   * false の場合は OAuth 2.1 方針として PKCE(S256) を必須にする。
   *
   * The pkce feature (features/pkce/) sets the default to false. A provider
   * generated with --disable pkce keeps the default of this file, true.
   */
  allowNonPkceAuthorizationCodeFlow: boolean;
}

/**
 * The defaults of the fields above. The features add theirs on top
 * (createProviderConfig()), the defaults of the fields they declare included.
 */
const baseProviderConfig = {
  issuer: 'http://localhost:3000',
  accessTokenExpiresIn: 3600,
  idTokenExpiresIn: 3600,
  // OAuth 2.1 §6.1: refresh token は initial issuance から 90 日（7776000 秒）で必ず失効する。
  refreshTokenAbsoluteLifetime: 7776000,
  // OIDC Core 1.0 §11: offline_access 無しの Refresh Token（online refresh token）も
  // 発行する。ログインセッションに束縛されるため、ログアウトすると使えなくなる。
  onlineRefreshTokenEnabled: true,
  accessTokenFormat: 'jwt',
  // OIDC Core 1.0 §3.1.3.1: authorization code は short-lived であるべき（5 分 = 300 秒）。
  authorizationCodeTtl: 300,
  allowNonPkceAuthorizationCodeFlow: true,
} satisfies Partial<ProviderConfig>;

/**
 * The settings of the provider: the defaults of this file, those of the
 * enabled features, and the overrides of the app, in that order.
 * Production code should take the overrides from environment variables, KV,
 * D1, or another project-owned configuration source.
 */
export function createProviderConfig(
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  // Every field a feature declares gets its default from the config entry of
  // that feature's feature.ts, so the merged object is a whole ProviderConfig.
  return {
    ...baseProviderConfig,
    ...configOf(features),
    ...overrides,
  } as ProviderConfig;
}

/**
 * Extended client info for this provider.
 *
 * Whether a client may receive refresh tokens is decided by the standard
 * `grantTypes` registration metadata (RFC 7591 §2 / OIDC Dynamic Client
 * Registration 1.0 §2) it already carries through TokenClientInfo — there is no
 * separate provider-specific switch. `grantTypes` containing `refresh_token`
 * gates both refresh token flavors; OIDC Core 1.0 §11 (prompt=consent) decides
 * which flavor the authorization produces.
 *
 * scope (RFC 7591 §2 `scope`, from ClientInfo / TokenClientInfo): the scope
 * values this client may request. When set, a request for any other scope is
 * rejected with invalid_scope at /authorize (and at the device and CIBA
 * endpoints when they are generated). Leave it out to let the client request
 * every scope the provider accepts.
 *
 * userinfoSignedResponseAlg: when set, the UserInfo endpoint returns a signed JWT
 * with content-type `application/jwt` (OIDC Core 1.0 Section 5.3.2 — client metadata
 * `userinfo_signed_response_alg`). The endpoint picks a registered UserInfo signing
 * key whose alg matches this value (mirroring idTokenSignedResponseAlg), so the
 * response is signed with the requested alg — not limited to RS256. A request whose
 * alg has no registered key is rejected as a server configuration error.
 *
 * idTokenSignedResponseAlg: chooses the JWA alg for this client's ID Token
 * (OIDC Dynamic Client Registration 1.0 §2 — client metadata
 * `id_token_signed_response_alg`). When omitted, the OIDC default `RS256` is used.
 * The token endpoint picks an actual signing key matching this alg from the
 * registered ID Token key set; a request whose alg has no registered key is
 * rejected as a server configuration error.
 *
 * The client's public keys are not part of it: each process that needs them
 * asks the ClientKeyResolver for the keys of its own purpose
 * (ClientRegistration.keys below, kept by registerClient() of db/).
 *
 * A feature that reads client metadata of its own adds it to this interface
 * from its directory (`declare module '../../config.js'` in features/<id>/),
 * so removing the feature removes the field.
 */
export interface RegisteredClient extends ClientInfo, TokenClientInfo {
  userinfoSignedResponseAlg?: 'RS256' | 'ES256';
  idTokenSignedResponseAlg?: 'RS256' | 'ES256';
}

/**
 * A client as registerClient() (db/clients.ts) takes it: the RegisteredClient
 * and its public keys by purpose (keys). A purpose names the process that uses
 * the keys, such as request_object for the signed Request Objects the OP
 * verifies (OIDC Core 1.0 §6.3.2), or private_key_jwt and dpop for processes a
 * project adds. Register the same key under two purposes to use it for both.
 *
 * clientSecret is the secret as the client presents it; registerClient()
 * stores only its hash (clientSecretHash).
 */
export type ClientRegistration = RegisteredClient & {
  keys?: ClientKeysByPurpose;
};
