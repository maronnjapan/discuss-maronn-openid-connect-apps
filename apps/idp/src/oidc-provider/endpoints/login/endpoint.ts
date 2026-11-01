import { defineEndpoint } from '../step.js';

/** The login screen. OIDC Core 1.0 §3.1.2.3 */
export const endpoint = defineEndpoint({
  id: 'login',
  order: 40,
  label: 'Login screen',
  path: '/login',
  methods: ['GET', 'POST'],
  layer: 'browser',
  group: { id: 'authorization-code', label: 'Authorization Code Flow' },
  spec: 'OIDC Core 1.0 §3.1.2.3',
  rearrangeable: false,
  steps: [
    'load-transaction',
    'describe-login-screen',
    'reject-cross-origin-post',
    'validate-csrf-token',
    'authenticate-user',
    'record-login-failure',
    'discard-session-for-fresh-login',
    'establish-session',
    'hand-off-to-consent',
  ],
  edges: {
    chain: false,
    extra: [
      { from: 'load-transaction', to: 'describe-login-screen', label: 'GET', kind: 'flow' },
      { from: 'reject-cross-origin-post', to: 'load-transaction', label: 'POST', kind: 'flow' },
      { from: 'load-transaction', to: 'validate-csrf-token', label: 'POST', kind: 'flow' },
      { from: 'validate-csrf-token', to: 'authenticate-user', kind: 'flow' },
      { from: 'authenticate-user', to: 'record-login-failure', label: 'wrong credentials', kind: 'branch' },
      { from: 'record-login-failure', to: 'describe-login-screen', label: 'retry', kind: 'branch' },
      { from: 'authenticate-user', to: 'discard-session-for-fresh-login', label: 'authenticated', kind: 'branch' },
      { from: 'discard-session-for-fresh-login', to: 'establish-session', kind: 'flow' },
      { from: 'establish-session', to: 'hand-off-to-consent', kind: 'flow' },
    ],
  },
  journeys: [
    { from: 'login', to: 'consent', label: 'authenticated', kind: 'flow', order: 80 },
  ],
});
