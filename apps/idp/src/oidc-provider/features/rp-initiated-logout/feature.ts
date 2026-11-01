import { defineFeature } from '../feature.js';
import { logoutPage } from './endpoints/logout/page.js';

/**
 * EXPERIMENTAL — OpenID Connect RP-Initiated Logout 1.0: the end session
 * endpoint GET|POST /logout and its confirmation POST /logout/approve.
 * Settings (the registered post_logout_redirect_uri values) are in config.ts.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable: it
 * may change in a breaking way between releases.
 */
export const rpInitiatedLogout = defineFeature({
  id: 'rp-initiated-logout',
  routes: [
    { path: '/logout', app: logoutPage, methods: ['GET', 'POST'], subpaths: { '/approve': ['POST'] } },
  ],
  // RP-Initiated Logout 1.0 §2.1 metadata.
  discovery: (issuer) => ({ end_session_endpoint: `${issuer}/logout` }),
});
