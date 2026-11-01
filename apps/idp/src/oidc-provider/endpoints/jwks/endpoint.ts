import { defineEndpoint } from '../step.js';

/** The JWK Set of the provider's public keys (jwks_uri). */
export const endpoint = defineEndpoint({
  id: 'jwks',
  order: 20,
  label: 'JWKS',
  path: '/.well-known/jwks.json',
  methods: ['GET'],
  layer: 'metadata',
  group: { id: 'metadata', label: 'Metadata' },
  spec: 'OIDC Discovery 1.0 §3 (jwks_uri)',
  rearrangeable: true,
  steps: [
    'collect-public-keys',
    'export-jwks',
    'respond',
  ],
  edges: {
    chain: true,
  },
});
