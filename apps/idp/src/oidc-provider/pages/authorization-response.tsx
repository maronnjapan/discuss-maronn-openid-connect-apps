/** @jsxImportSource hono/jsx */
/**
 * Authorization response (screen routing layer).
 *
 * /authorize and /consent end in the authorization response for the client,
 * in the response mode the request asked for (endpoints/authorize/
 * response-mode.ts): a redirect whose URL carries it, or an HTML form the
 * browser posts to the redirect URI. respondToClient() turns either into HTTP.
 * Customize the form page in views.tsx (formPostPage).
 */
import type { AuthorizationResponse } from '../endpoints/authorize/response-mode.js';
import { defaultViews, renderView, type Views } from '../views.js';
import { redirectWithCookies, withCookies } from './respond.js';

/** Send the authorization response to the client, with the given cookies attached. */
export function respondToClient(
  c: any,
  response: AuthorizationResponse,
  cookies: readonly string[] = [],
): Response {
  if (response.method === 'redirect') {
    return redirectWithCookies(response.location, cookies);
  }
  const views: Views = c.get('views') ?? defaultViews;
  // OAuth 2.0 Form Post Response Mode §2: the response is used only once, so
  // the User Agent and any intermediaries MUST NOT store or reuse it. These
  // are the headers of Appendix A.
  const page = renderView(<views.formPostPage action={response.action} fields={response.fields} />, {
    headers: { 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' },
  });
  return withCookies(page, cookies);
}
