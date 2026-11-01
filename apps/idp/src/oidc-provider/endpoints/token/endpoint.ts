import { defineEndpoint } from '../step.js';

/** The token endpoint. OIDC Core 1.0 §3.1.3 */
export const endpoint = defineEndpoint({
  id: 'token',
  order: 70,
  label: 'Token endpoint',
  path: '/token',
  methods: ['POST'],
  layer: 'api',
  group: { id: 'authorization-code', label: 'Authorization Code Flow' },
  spec: 'OIDC Core 1.0 §3.1.3',
  rearrangeable: true,
  steps: [
    'parse-request',
    'authenticate-client',
    'validate-grant-type',
    'validate-refresh-token-grant',
    'validate-authorization-code-grant',
    'select-signing-keys',
    'resolve-subject',
    'decide-refresh-token-issuance',
    'resolve-acr-amr',
    'issue-access-token',
    'issue-id-token',
    'persist-access-token',
    'issue-refresh-token',
    'revoke-rotated-refresh-token',
    'build-token-response',
    'respond',
    'respond-error',
  ],
  errorStep: 'respond-error',
  // The grant is validated by the step of its grant_type: the chain goes from
  // validate-grant-type through the step of each grant it forks to. A grant a
  // feature answers itself (a dispatch step of that feature) goes straight to
  // respond.
  edges: {
    chain: true,
    forks: [
      { at: 'validate-grant-type', branches: [
        { step: 'validate-authorization-code-grant', label: 'authorization_code' },
        { step: 'validate-refresh-token-grant', label: 'refresh_token' },
      ] },
    ],
    fromKind: [
      { kind: 'dispatch', to: 'respond', label: 'answered' },
    ],
  },
  journeys: [
    { from: 'token', to: 'userinfo', label: 'access_token', kind: 'flow', order: 100 },
  ],
});
