import { defineEndpoint } from '../step.js';

/** The UserInfo endpoint. OIDC Core 1.0 §5.3 */
export const endpoint = defineEndpoint({
  id: 'userinfo',
  order: 80,
  label: 'UserInfo endpoint',
  path: '/userinfo',
  methods: ['GET', 'POST'],
  layer: 'api',
  group: { id: 'authorization-code', label: 'Authorization Code Flow' },
  spec: 'OIDC Core 1.0 §5.3',
  rearrangeable: true,
  steps: [
    'parse-access-token',
    'resolve-access-token',
    'resolve-claims',
    'build-response',
    'respond',
    'respond-error',
  ],
  errorStep: 'respond-error',
  edges: {
    chain: true,
  },
});
