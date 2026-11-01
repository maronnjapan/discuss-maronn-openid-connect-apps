import { defineEndpoint } from '../step.js';

/** The consent screen. OIDC Core 1.0 §3.1.2.4 */
export const endpoint = defineEndpoint({
  id: 'consent',
  order: 60,
  label: 'Consent screen',
  path: '/consent',
  methods: ['GET', 'POST'],
  layer: 'browser',
  group: { id: 'authorization-code', label: 'Authorization Code Flow' },
  spec: 'OIDC Core 1.0 §3.1.2.4',
  rearrangeable: false,
  steps: [
    'load-transaction',
    'describe-consent-screen',
    'reject-cross-origin-post',
    'validate-csrf-token',
    'deny-authorization',
    'validate-decision',
    'require-authenticated-subject',
    'issue-authorization-code',
    'record-consent',
    'build-authorization-response',
  ],
  edges: {
    chain: false,
    extra: [
      { from: 'load-transaction', to: 'describe-consent-screen', label: 'GET', kind: 'flow' },
      { from: 'reject-cross-origin-post', to: 'load-transaction', label: 'POST', kind: 'flow' },
      { from: 'load-transaction', to: 'validate-csrf-token', label: 'POST', kind: 'flow' },
      { from: 'validate-csrf-token', to: 'deny-authorization', label: 'action=deny', kind: 'branch' },
      { from: 'validate-csrf-token', to: 'validate-decision', label: 'action=approve', kind: 'branch' },
      { from: 'validate-decision', to: 'require-authenticated-subject', kind: 'flow' },
      { from: 'require-authenticated-subject', to: 'issue-authorization-code', kind: 'flow' },
      { from: 'issue-authorization-code', to: 'record-consent', kind: 'flow' },
      { from: 'record-consent', to: 'build-authorization-response', kind: 'flow' },
    ],
  },
  journeys: [
    { from: 'consent', to: 'token', label: 'code', kind: 'flow', order: 90 },
  ],
});
