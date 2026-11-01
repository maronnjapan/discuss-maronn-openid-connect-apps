import {
  type ResolvedIntrospectionToken,
  isIntrospectionTokenActive,
  buildIntrospectionResponse,
  INACTIVE_INTROSPECTION_RESPONSE,
  type IntrospectionResponse,
} from '@maronn-openid-connect/core';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'build-response',
  endpoint: 'introspection',
  feature: 'introspection',
  kind: 'transform',
  label: 'Describe the token (active or not)',
  spec: 'RFC 7662 §2.2',
  function: 'describeIntrospectedToken',
  calls: ['isIntrospectionTokenActive', 'buildIntrospectionResponse'],
  consumes: ['resolved'],
  produces: ['introspection'],
  removable: false,
});

/**
 * Describe the token. RFC 7662 §2.2: an unknown, expired, not-yet-valid or
 * rotated token is reported as { active: false } with no other member, so the
 * caller cannot distinguish "never existed" from "no longer valid".
 */
export function describeIntrospectedToken(resolved: ResolvedIntrospectionToken | null): IntrospectionResponse {
  if (resolved !== null && isIntrospectionTokenActive(resolved)) {
    return buildIntrospectionResponse(resolved);
  }
  return INACTIVE_INTROSPECTION_RESPONSE;
}
