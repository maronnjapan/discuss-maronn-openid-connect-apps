import { defineFeature } from '../feature.js';
import './config.js';

/**
 * Request Objects passed by value: the request parameter of the
 * authorization request (OIDC Core 1.0 §6.1 / §6.3.2). The
 * resolve-request-object block of endpoints/authorize/pipeline.ts verifies it
 * against the keys the client registered for request_object and overlays its
 * claims. Without the feature the request parameter is rejected with
 * request_not_supported.
 */
export const requestObject = defineFeature({
  id: 'request-object',
  // OIDC Core 1.0 §6.1: require signed Request Objects by default; enable only for
  // Basic OP conformance compatibility where the suite sends unsigned ones.
  config: { allowUnsignedRequestObject: false },
  // OIDC Core 1.0 §6.1 / OIDC Discovery 1.0 §3: signed Request Object by value is
  // supported (verified against the client's registered JWKS). RS256 is the
  // required signing alg; 'none' is added only when unsigned objects are
  // accepted for Basic OP conformance compatibility.
  discovery: (_issuer, config) => ({
    request_parameter_supported: true,
    request_object_signing_alg_values_supported: config.allowUnsignedRequestObject
      ? ['RS256', 'none']
      : ['RS256'],
  }),
});
