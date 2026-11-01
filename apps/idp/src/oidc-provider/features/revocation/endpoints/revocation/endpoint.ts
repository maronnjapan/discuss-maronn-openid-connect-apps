import { defineEndpoint } from '../../../../endpoints/step.js';

/** Token Revocation. RFC 7009 §2 */
export const endpoint = defineEndpoint({
  id: 'revocation',
  order: 100,
  label: 'Token revocation endpoint',
  path: '/revoke',
  methods: ['POST'],
  layer: 'api',
  group: { id: 'token-management', label: 'Token management' },
  spec: 'RFC 7009 §2',
  feature: 'revocation',
  rearrangeable: true,
  steps: [
    'parse-request',
    'authenticate-client',
    'resolve-token',
    'revoke-token',
    'respond',
    'respond-error',
  ],
  errorStep: 'respond-error',
  edges: {
    chain: true,
  },
  journeys: [
    { from: 'token', to: 'revocation', label: 'token', kind: 'flow', order: 120 },
  ],
});
