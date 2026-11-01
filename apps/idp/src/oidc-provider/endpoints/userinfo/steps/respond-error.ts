import { UserInfoError } from '@maronn-openid-connect/core';
import { UserInfoEndpointError } from '../response.js';
import { respondUserInfo } from './respond.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'respond-error',
  endpoint: 'userinfo',
  kind: 'respond',
  label: 'Respond with the Bearer challenge',
  spec: 'RFC 6750 §3',
  function: 'respondUserInfoError',
  consumes: [],
  produces: [],
  removable: false,
});

/**
 * Answer a failure of any step: the Bearer challenge of RFC 6750 §3 for a
 * token the pipeline rejected, the fixed response a step decided, or
 * server_error.
 */
export function respondUserInfoError(c: any, error: unknown): Response {
  if (error instanceof UserInfoEndpointError) {
    return respondUserInfo(c, error.response);
  }
  if (error instanceof UserInfoError) {
    return respondUserInfo(c, {
      status: error.statusCode,
      body: { error: error.error, error_description: error.errorDescription },
      headers: {
        'WWW-Authenticate': `Bearer realm="UserInfo", error="${error.error}", error_description="${error.errorDescription}"`,
      },
    });
  }
  return respondUserInfo(c, { status: 500, body: { error: 'server_error' } });
}
