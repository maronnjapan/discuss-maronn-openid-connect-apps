/**
 * The storage contract of the provider: what the endpoints read and write,
 * and nothing about where it is kept.
 *
 * db/ implements it. The provider is generated with one kind of database
 * (--db): db/memory keeps everything in this process, db/sql in SQL tables,
 * db/kv in a key-value store. Pass your own ProviderStores through the
 * storage option of createApp() / applyOidc() to keep the data elsewhere.
 */
import type {
  AccessTokenInfo,
  AuthTransactionStore,
  AuthorizationCodeInfo,
  RefreshTokenInfo,
  UserClaims,
} from '@maronn-openid-connect/core';

export type Awaitable<T> = T | Promise<T>;

/**
 * The login result handed from the login step to the consent step, per
 * transaction.
 */
export interface AuthSessionInfo {
  subject: string;
  authTime: number;
  /**
   * このログインで確立（または再利用）したブラウザセッションの識別子。
   * consent 画面を経て発行する認可コードへ引き継ぎ、online refresh token を
   * そのセッションへ束縛するために使う。
   */
  sessionId?: string;
}

/**
 * The browser (OP) session - OIDC Core 1.0 Section 3.1.2.3. It lasts across
 * authorization requests, keyed by the session id of the session cookie
 * (cookies.ts), and is what makes SSO, prompt=none and max_age work.
 */
export interface BrowserSessionInfo {
  subject: string;
  authTime: number;
}

/** An account of a user at an upstream identity provider, such as Google. */
export interface FederatedIdentity {
  /** The upstream identity provider ('google'). */
  provider: string;
  /** The subject at the upstream provider (its sub claim), which it never reassigns. */
  subject: string;
  /** The claims the provider asserted about the account. sub is the OP's own and is left out. */
  claims: Omit<UserClaims, 'sub'>;
}

/** A sign-in at an upstream identity provider that a transaction waits for. */
export interface UpstreamLogin {
  provider: string;
  transactionId: string;
  /** Unix time in milliseconds; the record is gone after it (the transaction's expiresAt). */
  expiresAt: number;
}

/**
 * The authorization transactions: core's AuthTransactionStore, and how a
 * transaction ended when the authorization endpoint returned its tokens
 * itself.
 */
export interface TransactionStorage extends AuthTransactionStore {
  /**
   * Record that the tokens of the transaction were issued from the
   * authorization endpoint without a code: the Implicit Flow (OIDC Core 1.0
   * §3.2.2.5) returns its ID Token there. A transaction of the code flow gets
   * to the same point when its code is exchanged. Optional: a store that does
   * not keep how a transaction ended leaves it out.
   */
  recordTokenIssued?(transactionId: string): Awaitable<void>;
}

export interface AuthorizationCodeStorage {
  set(code: string, info: AuthorizationCodeInfo): Awaitable<void>;
  /** undefined for an expired code; a used one is returned, with used: true. */
  get(code: string): Awaitable<AuthorizationCodeInfo | undefined>;
  /**
   * Mark the code used, never delete it: OAuth 2.1 §4.1.2 / RFC 9700 §4.13 —
   * a replayed code must still be found as used so its grant can be revoked.
   */
  consume(code: string): Awaitable<void>;
  delete(code: string): Awaitable<void>;
}

export interface AccessTokenStorage {
  set(token: string, info: AccessTokenInfo): Awaitable<void>;
  get(token: string): Awaitable<AccessTokenInfo | undefined>;
  delete(token: string): Awaitable<void>;
  /** OAuth 2.1 §4.1.2: revoke every access token of a grant (code reuse). */
  revokeByGrantId(grantId: string): Awaitable<void>;
  /** Revoke one access token (RFC 7009). */
  revoke(token: string): Awaitable<void>;
}

export interface RefreshTokenStorage {
  set(token: string, info: RefreshTokenInfo): Awaitable<void>;
  get(token: string): Awaitable<RefreshTokenInfo | undefined>;
  /**
   * Mark a rotated refresh token used, never delete it: OAuth 2.1 §4.3.1 /
   * RFC 9700 §4.13 — a replay must still be found so the grant is revoked.
   */
  consume(token: string): Awaitable<void>;
  delete(token: string): Awaitable<void>;
  /** OAuth 2.1 Section 4.1.2: revoke every refresh token of a grant, the rotated ones included. */
  revokeByGrantId(grantId: string): Awaitable<void>;
  /** Revoke one refresh token (RFC 7009). */
  revoke(token: string): Awaitable<void>;
}

export interface AuthSessionStorage {
  set(transactionId: string, info: AuthSessionInfo): Awaitable<void>;
  get(transactionId: string): Awaitable<AuthSessionInfo | undefined>;
  delete(transactionId: string): Awaitable<void>;
}

export interface BrowserSessionStorage {
  set(sessionId: string, info: BrowserSessionInfo): Awaitable<void>;
  get(sessionId: string): Awaitable<BrowserSessionInfo | undefined>;
  delete(sessionId: string): Awaitable<void>;
}

/**
 * The scopes a user granted to a client, so prompt=none can confirm consent
 * without UI (OIDC Core 1.0 Section 3.1.2.1), and the grants issued under it,
 * so removing access revokes their tokens.
 */
export interface ConsentStorage {
  grant(subject: string, clientId: string, scopes: string[]): Awaitable<void>;
  /** true only when every requested scope was granted. */
  hasConsent(subject: string, clientId: string, scopes: string[]): Awaitable<boolean>;
  recordGrant(subject: string, clientId: string, grantId: string): Awaitable<void>;
  /** Remove the consent and return the grant ids whose tokens the caller revokes. */
  revoke(subject: string, clientId: string): Awaitable<string[]>;
}

export interface UserStorage {
  authenticate(
    username: string,
    password: string,
  ): Awaitable<(UserClaims & { password: string }) | undefined>;
  getClaims(sub: string): Awaitable<UserClaims | undefined>;
  /**
   * Find or create the user of an upstream account (just-in-time
   * provisioning) by its federated identity, never by email, save the claims
   * the provider asserted, and return the user's claims.
   */
  linkFederatedIdentity(identity: FederatedIdentity): Awaitable<UserClaims>;
}

/** The upstream sign-ins in progress, found by the nonce the OP sent upstream. */
export interface UpstreamLoginStorage {
  find(nonce: string): Awaitable<UpstreamLogin | undefined>;
  save(nonce: string, login: UpstreamLogin): Awaitable<void>;
  delete(nonce: string): Awaitable<void>;
}

export interface ProviderStores {
  transactionStore: TransactionStorage;
  authCodeStore: AuthorizationCodeStorage;
  accessTokenStore: AccessTokenStorage;
  refreshTokenStore: RefreshTokenStorage;
  authSessionStore: AuthSessionStorage;
  browserSessionStore: BrowserSessionStorage;
  consentStore: ConsentStorage;
  userStore: UserStorage;
  upstreamLoginStore: UpstreamLoginStorage;
}

/** Stores per request: the request context in, the stores of that request out. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ProviderStoresFactory = (context: any) => Awaitable<ProviderStores>;
