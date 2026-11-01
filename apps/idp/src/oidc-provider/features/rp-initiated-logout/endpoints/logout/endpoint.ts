import { defineEndpoint } from '../../../../endpoints/step.js';

/** EXPERIMENTAL — the end session endpoint. RP-Initiated Logout 1.0 §2 */
export const endpoint = defineEndpoint({
  id: 'logout',
  order: 170,
  label: 'End session endpoint',
  path: '/logout',
  methods: ['GET', 'POST'],
  layer: 'browser',
  group: { id: 'logout', label: 'RP-Initiated Logout 1.0' },
  spec: 'RP-Initiated Logout 1.0 §2',
  feature: 'rp-initiated-logout',
  rearrangeable: false,
  steps: [
    'process-end-session-request',
    'approve-logout',
  ],
  edges: {
    chain: false,
    extra: [
      { from: 'process-end-session-request', to: 'approve-logout', label: 'confirmation screen', kind: 'branch' },
    ],
  },
  journeys: [
    { from: 'token', to: 'logout', label: 'id_token_hint', kind: 'flow', order: 170 },
  ],
});
