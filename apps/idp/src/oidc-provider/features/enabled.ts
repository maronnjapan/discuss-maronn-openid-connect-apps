/**
 * The features of this provider, in the order their hooks apply.
 *
 * `maronn-oidc generate` writes this file with the features of --enable /
 * --disable, one import and one entry each. To remove a feature by hand,
 * delete its line in both places, its directory under features/, the owner
 * blocks that name it in the pipelines (with their imports) and the lines of
 * its steps in the endpoint.ts files (with the edges to and from them).
 */
import type { Feature } from './feature.js';
import { pkce } from './pkce/feature.js';
import { refreshToken } from './refresh-token/feature.js';
import { introspection } from './introspection/feature.js';
import { revocation } from './revocation/feature.js';
import { requestObject } from './request-object/feature.js';
import { formPostResponseMode } from './form-post-response-mode/feature.js';
import { rpInitiatedLogout } from './rp-initiated-logout/feature.js';

export const features: readonly Feature[] = [
  pkce,
  refreshToken,
  introspection,
  revocation,
  requestObject,
  formPostResponseMode,
  rpInitiatedLogout,
];
