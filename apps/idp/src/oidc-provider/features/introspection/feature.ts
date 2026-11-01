import { defineFeature } from '../feature.js';
import { introspectionApp } from './endpoints/introspection/pipeline.js';
import { createIntrospectionResolvers } from './resolvers.js';

/** OAuth 2.0 Token Introspection (RFC 7662): POST /introspect. */
export const introspection = defineFeature({
  id: 'introspection',
  routes: [{ path: '/introspect', app: introspectionApp, methods: ['POST'], cors: 'protected' }],
  // RFC 8414: the endpoint requires confidential client authentication.
  discovery: (issuer) => ({
    introspection_endpoint: `${issuer}/introspect`,
    introspection_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  }),
  context: ({ stores }) => createIntrospectionResolvers(stores),
});
