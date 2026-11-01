/**
 * The Form Post Response Mode (OAuth 2.0 Form Post Response Mode, OpenID
 * Foundation Final 2015-04-27), as the authorization endpoint answers in it.
 *
 * The authorization response parameters (code and state, or the error
 * members) and iss (RFC 9207 §2) become the fields of an HTML form whose
 * action is the client's redirect URI, and the browser posts them
 * (respondToClient() in pages/authorization-response.tsx renders the form). None of
 * them appears in a URL, the browser history or a Referer header (§4).
 */
import type {
  AuthorizationResponseMode,
  AuthorizationResponseModeHandler,
} from '../../endpoints/authorize/response-mode.js';
import { contribute } from '../../endpoints/step.js';

/**
 * What the Form Post Response Mode adds to the build-authorization-response
 * box of the consent endpoint: the response it restores can be the form of
 * Form Post Response Mode §2.
 */
export const contribution = contribute({
  endpoint: 'consent',
  step: 'build-authorization-response',
  feature: 'form-post-response-mode',
  spec: 'OAuth 2.0 Form Post Response Mode §2',
});

/** The response_mode value (Form Post Response Mode §2), and the name the transaction stores. */
export const FORM_POST_RESPONSE_MODE_NAME = 'form_post';

/** The Form Post Response Mode of an issuer. */
export function createFormPostResponseMode(input: { issuer: string }): AuthorizationResponseMode {
  return {
    name: FORM_POST_RESPONSE_MODE_NAME,
    async respond(redirectUri, parameters) {
      const fields: Record<string, string> = {};
      for (const [name, value] of Object.entries(parameters)) {
        if (value) fields[name] = value;
      }
      // RFC 9207 §2: iss is a parameter of every authorization response, in
      // whichever response mode it is returned.
      fields['iss'] = input.issuer;
      // Form Post Response Mode §2: the action is the redirect URI, query included.
      return { method: 'form_post', action: redirectUri, fields };
    },
  };
}

/**
 * The Form Post Response Mode of a stored transaction: /consent answers in it
 * when the authorization request asked for response_mode=form_post.
 */
export const formPostResponseModeHandler: AuthorizationResponseModeHandler = {
  names: [FORM_POST_RESPONSE_MODE_NAME],
  restore(_c, { issuer }) {
    return createFormPostResponseMode({ issuer });
  },
};
