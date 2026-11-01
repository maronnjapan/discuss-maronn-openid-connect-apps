/** @jsxImportSource hono/jsx */
/**
 * EXPERIMENTAL — the views of the RP-Initiated Logout screens
 * (RP-Initiated Logout 1.0 §2), in hono/jsx.
 *
 * They are members of Views (views.tsx), added below, so the views option of
 * createApp() / applyOidc() can replace them like the login and consent
 * views. A member left out falls back to the default of this file.
 */
import type { JSX } from 'hono/jsx/jsx-runtime';
import {
  Layout,
  type Views,
} from '../../views.js';

export interface LogoutConfirmationPageParams {
  /** CSRF token (must be included as hidden form field of the approve POST) */
  csrfToken: string;
}

/**
 * Parameters of the logged-out page. Deliberately empty: the completed screen
 * shows no End-User or client identifier (whoever sees the screen learns
 * nothing), and its wording never depends on whether anything was actually
 * deleted — varying it would make the page a session-existence oracle.
 */
export interface LogoutCompletedPageParams {}

declare module '../../views.js' {
  interface Views {
    /** EXPERIMENTAL (RP-Initiated Logout 1.0 §2): render the logout confirmation screen */
    logoutConfirmationPage?(params: LogoutConfirmationPageParams): ViewResult;
    /** EXPERIMENTAL (RP-Initiated Logout 1.0): render the logged-out screen */
    logoutCompletedPage?(params: LogoutCompletedPageParams): ViewResult;
  }
}

// RP-Initiated Logout 1.0 §2: the wording is fixed for every path into this
// screen (no hint, an invalid or expired hint, another user's session, no
// session at all), so the page cannot be used as an oracle for session state
// or for why the hint failed.
function defaultLogoutConfirmationPage(params: LogoutConfirmationPageParams): JSX.Element {
  return (
    <Layout title="Log out">
      <h1>Log out</h1>
      <p>Do you want to log out of the OpenID Provider?</p>
      <p>If you did not request this, close this page.</p>
      <form method="post" action="/logout/approve">
        <input type="hidden" name="csrf_token" value={params.csrfToken} />
        <button type="submit">Log out</button>
      </form>
    </Layout>
  );
}

function defaultLogoutCompletedPage(_params: LogoutCompletedPageParams): JSX.Element {
  return (
    <Layout title="Logged out">
      <h1>Logged out</h1>
      <p>You have been logged out.</p>
      <p>You can close this page.</p>
    </Layout>
  );
}

/** The views of the request for these screens: the ones the app replaced, else the defaults above. */
export function logoutViews(c: any): Required<Pick<Views, 'logoutConfirmationPage' | 'logoutCompletedPage'>> {
  const views: Partial<Views> = c.get('views') ?? {};
  return {
    logoutConfirmationPage: views.logoutConfirmationPage ?? defaultLogoutConfirmationPage,
    logoutCompletedPage: views.logoutCompletedPage ?? defaultLogoutCompletedPage,
  };
}
