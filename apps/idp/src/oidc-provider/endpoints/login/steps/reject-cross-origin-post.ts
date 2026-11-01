import { isSameOriginFormPost, CROSS_ORIGIN_FORM_POST_MESSAGE } from '../../../cookies.js';
import type { LoginError } from '../screen.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'reject-cross-origin-post',
  endpoint: 'login',
  kind: 'validate',
  label: 'Reject a form POST from another origin',
  function: 'rejectCrossOriginFormPost',
  calls: ['isSameOriginFormPost'],
  consumes: [],
  produces: [],
  removable: false,
});

/**
 * [reject-cross-origin-post] Refuse a login form POST that the browser says
 * came from anywhere but the OP's own pages (403, never redirected). See
 * isSameOriginFormPost() in cookies.ts.
 */
export function rejectCrossOriginFormPost(c: any): LoginError | undefined {
  const sameOrigin = isSameOriginFormPost(
    { origin: c.req.header('Origin') ?? null, secFetchSite: c.req.header('Sec-Fetch-Site') ?? null },
    c.get('config').issuer,
  );
  return sameOrigin ? undefined : { kind: 'error', error: CROSS_ORIGIN_FORM_POST_MESSAGE, statusCode: 403 };
}
