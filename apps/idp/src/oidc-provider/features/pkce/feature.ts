import { defineFeature } from '../feature.js';

/**
 * PKCE (RFC 7636) for every client: OAuth 2.1 §4.1.1 / §7.5.
 *
 * Every provider checks a code_challenge a request carries and requires one
 * from public clients. This feature makes it required of confidential
 * clients too, by setting the default of allowNonPkceAuthorizationCodeFlow
 * (config.ts) to false. It is a feature rather than a runtime switch because
 * the relaxation exists only for the OpenID Certification tests that send
 * no PKCE: a provider generated with --disable pkce has it, the default one
 * does not.
 */
export const pkce = defineFeature({
  id: 'pkce',
  config: { allowNonPkceAuthorizationCodeFlow: false },
});
