import type { AuthorizationRequestParams } from '@maronn-openid-connect/core';
import type { AuthorizationResponseMode } from '../../../endpoints/authorize/response-mode.js';
import { step } from '../../../endpoints/step.js';
import { createFormPostResponseMode, FORM_POST_RESPONSE_MODE_NAME } from '../response-mode.js';

export const meta = step({
  id: 'resolve-form-post-response-mode',
  endpoint: 'authorize',
  feature: 'form-post-response-mode',
  kind: 'resolve',
  label: 'Interpret response_mode=form_post',
  spec: 'OAuth 2.0 Form Post Response Mode §2',
  function: 'resolveFormPostResponseContext',
  consumes: ['params', 'effectiveParams', 'issuer'],
  optional: ['effectiveParams'],
  produces: ['responseMode'],
  removable: false,
});

/**
 * Form Post Response Mode §2: answer in the form_post response mode when the
 * request asked for it — in the query, or in the Request Object, whose claims
 * supersede the query (OIDC Core 1.0 §6.1). The value is compared
 * case-sensitively (OAuth 2.0 Multiple Response Type Encoding Practices §2.1).
 * Any other value leaves the response mode undefined: the plain query
 * response, or the response mode of another feature.
 */
export function resolveFormPostResponseContext(
  params: AuthorizationRequestParams,
  issuer: string,
): AuthorizationResponseMode | undefined {
  const requested = (params as { response_mode?: unknown }).response_mode;
  if (requested !== FORM_POST_RESPONSE_MODE_NAME) return undefined;
  return createFormPostResponseMode({ issuer });
}
