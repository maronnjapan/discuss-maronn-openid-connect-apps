import { defineFeature } from '../feature.js';
import { revocationApp } from './endpoints/revocation/pipeline.js';
import { createRevocationResolvers } from './resolvers.js';

/** OAuth 2.0 Token Revocation (RFC 7009): POST /revoke. */
export const revocation = defineFeature({
  id: 'revocation',
  routes: [{ path: '/revoke', app: revocationApp, methods: ['POST'], cors: 'protected' }],
  // RFC 8414: confidential clients authenticate with their registered method.
  discovery: (issuer) => ({
    revocation_endpoint: `${issuer}/revoke`,
    revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  }),
  context: ({ stores }) => ({ revocationResolvers: createRevocationResolvers(stores) }),
});
