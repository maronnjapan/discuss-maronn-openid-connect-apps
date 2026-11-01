/**
 * The resolvers the introspection endpoint looks the presented token up with,
 * on the stores of the request.
 */
import type {
  IntrospectionAccessTokenResolver,
  IntrospectionRefreshTokenResolver,
} from '@maronn-openid-connect/core';
import type { ProviderStores } from '../../store.js';

export function createIntrospectionResolvers(stores: ProviderStores): {
  introspectionAccessTokenResolver: IntrospectionAccessTokenResolver;
  introspectionRefreshTokenResolver: IntrospectionRefreshTokenResolver;
} {
  return {
    introspectionAccessTokenResolver: {
      async findAccessToken(token) {
        return (await stores.accessTokenStore.get(token)) ?? null;
      },
    },
    introspectionRefreshTokenResolver: {
      async resolve(token) {
        return (await stores.refreshTokenStore.get(token)) ?? null;
      },
    },
  };
}
