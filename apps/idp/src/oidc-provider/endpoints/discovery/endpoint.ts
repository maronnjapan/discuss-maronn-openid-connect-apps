import { defineEndpoint } from '../step.js';

/** OpenID Connect Discovery. OIDC Discovery 1.0 §4 */
export const endpoint = defineEndpoint({
  id: 'discovery',
  order: 10,
  label: 'Discovery',
  path: '/.well-known/openid-configuration',
  methods: ['GET'],
  layer: 'metadata',
  group: { id: 'metadata', label: 'Metadata' },
  spec: 'OIDC Discovery 1.0 §4',
  rearrangeable: true,
  steps: [
    'collect-signing-algorithms',
    'build-metadata',
    'respond',
  ],
  edges: {
    chain: true,
  },
});
