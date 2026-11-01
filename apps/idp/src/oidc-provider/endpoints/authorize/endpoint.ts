import { defineEndpoint } from '../step.js';

/** The authorization endpoint. OIDC Core 1.0 §3.1.2 */
export const endpoint = defineEndpoint({
  id: 'authorize',
  order: 30,
  label: 'Authorization endpoint',
  path: '/authorize',
  methods: ['GET', 'POST'],
  layer: 'browser',
  group: { id: 'authorization-code', label: 'Authorization Code Flow' },
  spec: 'OIDC Core 1.0 §3.1.2',
  rearrangeable: true,
  // Defined before the first step: the issuer of the provider. The response
  // mode is declared there too (undefined unless a step of a feature, such as
  // JARM's, form_post's or the Implicit Flow's fragment, which the Hybrid
  // Flow shares, sets it), so the error step can read it whichever step
  // failed.
  initial: ['issuer'],
  steps: [
    'parse-request',
    'resolve-client',
    'resolve-request-object',
    'resolve-redirect-uri',
    'resolve-form-post-response-mode',
    'validate-request',
    'create-transaction',
    'validate-prompt-combination',
    'verify-id-token-hint',
    'authenticate-silently',
    'reuse-session',
    'issue-authorization-code',
    'continue-to-login',
    'respond-error',
  ],
  errorStep: 'respond-error',
  edges: {
    chain: true,
    off: ['issue-authorization-code'],
    extra: [
      { from: 'authenticate-silently', to: 'issue-authorization-code', label: 'session + consent', kind: 'branch' },
      { from: 'reuse-session', to: 'issue-authorization-code', label: 'session + prior consent', kind: 'branch' },
      { from: 'reuse-session', to: 'continue-to-login', label: 'consent screen', kind: 'branch' },
    ],
  },
  journeys: [
    { from: 'authorize', to: 'login', label: 'login required', kind: 'flow', order: 30 },
    { from: 'authorize', to: 'consent', label: 'SSO: consent required', kind: 'flow', order: 40 },
    { from: 'authorize', to: 'token', label: 'code (prompt=none / SSO)', kind: 'flow', order: 50 },
  ],
});
