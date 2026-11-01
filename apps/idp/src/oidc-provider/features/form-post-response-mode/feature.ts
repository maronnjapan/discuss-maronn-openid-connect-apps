import { defineFeature } from '../feature.js';
import { FORM_POST_RESPONSE_MODE_NAME, formPostResponseModeHandler } from './response-mode.js';

/**
 * OAuth 2.0 Form Post Response Mode (OpenID Foundation Final 2015-04-27):
 * response_mode=form_post returns the authorization response as an HTML form
 * that the browser posts to the redirect URI, instead of a redirect whose
 * query carries it. The resolve-form-post-response-mode block of
 * endpoints/authorize/pipeline.ts reads the request, and /consent answers in
 * the same mode through authorize.responseModes. A request that does not ask
 * for form_post is answered exactly as before.
 */
export const formPostResponseMode = defineFeature({
  id: 'form-post-response-mode',
  authorize: { responseModes: [formPostResponseModeHandler] },
  // OIDC Discovery 1.0 §3: advertised alongside query.
  discovery: () => ({ response_modes_supported: [FORM_POST_RESPONSE_MODE_NAME] }),
});
