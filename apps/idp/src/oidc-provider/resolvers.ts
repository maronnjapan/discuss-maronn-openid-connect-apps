/**
 * The resolvers core takes, on one set of ProviderStores (store.ts).
 *
 * Build them over one coherent store set: a request must never mix resolvers
 * of one backend with stores of another.
 */
import type {
  AccessTokenInfo,
  AccessTokenResolver,
  AuthenticationSessionInfo,
  AuthenticationSessionResolver,
  AuthorizationCodeInfo,
  AuthorizationCodeResolver,
  ConsentResolver,
  RefreshTokenInfo,
  RefreshTokenResolver,
  SessionInfo,
  SessionResolver,
  UserClaims,
  UserClaimsResolver,
} from '@maronn-openid-connect/core';
import { parseSessionId } from './cookies.js';
import type { ProviderStores } from './store.js';

/** A ConsentResolver that also records the grants issued under a consent. */
export type GrantAwareConsentResolver = ConsentResolver & {
  recordGrant(subject: string, clientId: string, grantId: string): Promise<void>;
};

export type StoreResolvers = ReturnType<typeof createStoreResolvers>;

export function createStoreResolvers(stores: ProviderStores) {
  const {
    authCodeStore,
    accessTokenStore,
    refreshTokenStore,
    userStore,
    browserSessionStore,
    consentStore,
  } = stores;

  const authorizationCodeResolver: AuthorizationCodeResolver = {
    async findAuthorizationCode(code: string): Promise<AuthorizationCodeInfo | null> {
      return (await authCodeStore.get(code)) ?? null;
    },
    async revokeAuthorizationCode(code: string): Promise<void> {
      await authCodeStore.consume(code);
    },
    async revokeTokensByGrantId(grantId: string): Promise<void> {
      await accessTokenStore.revokeByGrantId(grantId);
      await refreshTokenStore.revokeByGrantId(grantId);
    },
  };

  const accessTokenResolver: AccessTokenResolver = {
    async findAccessToken(token: string): Promise<AccessTokenInfo | null> {
      return (await accessTokenStore.get(token)) ?? null;
    },
  };

  const refreshTokenResolver: RefreshTokenResolver = {
    async resolve(token: string): Promise<RefreshTokenInfo | null> {
      return (await refreshTokenStore.get(token)) ?? null;
    },
    async revokeRefreshToken(token: string): Promise<void> {
      await refreshTokenStore.consume(token);
    },
    async revokeTokensByGrantId(grantId: string): Promise<void> {
      await accessTokenStore.revokeByGrantId(grantId);
      await refreshTokenStore.revokeByGrantId(grantId);
    },
  };

  const userClaimsResolver: UserClaimsResolver = {
    async findUserClaims(sub: string): Promise<UserClaims | null> {
      return (await userStore.getClaims(sub)) ?? null;
    },
  };

  const sessionResolver: SessionResolver = {
    async resolve(request: Request): Promise<SessionInfo | null> {
      const sessionId = parseSessionId(request.headers.get('Cookie'));
      if (!sessionId) return null;
      const session = await browserSessionStore.get(sessionId);
      if (!session) return null;
      // sessionId まで返すのは online refresh token のため。認可コードへ引き継ぎ、
      // トークンエンドポイントが Refresh Token をこのセッションへ束縛する。
      return { subject: session.subject, authTime: session.authTime, sessionId };
    },
  };

  // online refresh token の束縛先セッションを sessionId から引く。sessionResolver は
  // Cookie を持つブラウザリクエストから引く入口で、トークンエンドポイントには End-User の
  // Cookie が届かないため、保存された sessionId から直接引くこちらが要る。
  // 終了したセッションでは必ず null を返すこと。返し続けると online refresh token が
  // ログアウト後も使えてしまう。
  const authenticationSessionResolver: AuthenticationSessionResolver = {
    async findSession(sessionId: string): Promise<AuthenticationSessionInfo | null> {
      const session = await browserSessionStore.get(sessionId);
      if (!session) return null;
      return { subject: session.subject, authTime: session.authTime };
    },
  };

  const revokeConsentAndTokens = async (subject: string, clientId: string): Promise<void> => {
    const grantIds = await consentStore.revoke(subject, clientId);
    for (const grantId of grantIds) {
      await authorizationCodeResolver.revokeTokensByGrantId?.(grantId);
    }
  };

  const consentResolver: GrantAwareConsentResolver = {
    async hasConsent(subject: string, clientId: string, scopes: string[]): Promise<boolean> {
      return consentStore.hasConsent(subject, clientId, scopes);
    },
    async recordConsent(subject: string, clientId: string, scopes: string[]): Promise<void> {
      await consentStore.grant(subject, clientId, scopes);
    },
    async recordGrant(subject: string, clientId: string, grantId: string): Promise<void> {
      await consentStore.recordGrant(subject, clientId, grantId);
    },
    async revokeConsent(subject: string, clientId: string): Promise<void> {
      await revokeConsentAndTokens(subject, clientId);
    },
  };

  return {
    authorizationCodeResolver,
    accessTokenResolver,
    refreshTokenResolver,
    authenticationSessionResolver,
    userClaimsResolver,
    sessionResolver,
    consentResolver,
    revokeConsentAndTokens,
  };
}
