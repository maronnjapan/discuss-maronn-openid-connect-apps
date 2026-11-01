/** @jsxImportSource hono/jsx */
/**
 * UI Views for OpenID Connect Provider (hono/jsx).
 *
 * This file contains the default markup of the login, consent and error
 * screens, written as JSX. The screen routes deliver these views (the login
 * page renders <views.loginPage {...params} />, and so on); the logic of the
 * endpoints never renders anything — it returns outcomes the pages turn into
 * HTTP. Customize these components to match your application's design, or
 * change how a screen is delivered in its page module. The screens a feature
 * adds (the device flow, CIBA, logout) are in the views.tsx of that feature,
 * and use the building blocks exported here.
 *
 * Every view is a hono/jsx component: it receives typed parameters as its
 * props and returns a JSX element (ViewResult), which renderView turns into
 * the Response the page sends. To control the Response itself (status,
 * headers, a body from another renderer), change the render*Page() helper of
 * the screen instead.
 *
 * JSX escapes every value interpolated with {...}, in text and in attributes,
 * so untrusted input (login_hint, error_description, binding_message, ...) is
 * rendered safely without manual escaping. Never hand such a value to raw()
 * or dangerouslySetInnerHTML.
 *
 * Compiling this file needs JSX enabled in tsconfig.json:
 *   "jsx": "react-jsx", "jsxImportSource": "hono/jsx"
 */
import type { Child } from 'hono/jsx';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { raw } from 'hono/html';

// ============================================================
// View Parameter Types
// ============================================================

export interface LoginPageParams {
  /**
   * CSRF token (must be included as the hidden csrf_token form field). The form
   * carries nothing else about the transaction: the browser's transaction cookie
   * says which one this is, and the token has to belong to it.
   */
  csrfToken: string;
  /** Error message from a previous failed attempt */
  error?: string;
  /** Number of remaining login attempts */
  remainingAttempts?: number;
  /**
   * OIDC Core 1.0 §3.1.2.1 login_hint: untrusted external value the OP MAY use to
   * pre-fill the login form. Treated as a hint only (initial display); it MUST be
   * HTML-attribute escaped before rendering since it is unauthenticated input.
   */
  loginHint?: string;
  /**
   * The other ways to sign in that the features offer (the login methods of
   * features/feature.ts, such as Sign in with Google), already rendered.
   * Shown below the password form.
   */
  loginMethods?: ViewResult[];
}

export interface ConsentPageParams {
  /**
   * CSRF token (must be included as the hidden csrf_token form field). The form
   * carries nothing else about the transaction: the browser's transaction cookie
   * says which one this is, and the token has to belong to it.
   */
  csrfToken: string;
  /** Scopes requested by the client */
  scopes: string[];
  /** Client ID requesting authorization */
  clientId: string;
}

/**
 * OAuth 2.0 Form Post Response Mode §2: the authorization response the browser
 * posts to the client. The view must keep the form as it is — method POST,
 * action and the fields exactly as given — and may only change what is
 * around it.
 */
export interface FormPostPageParams {
  /** The client's redirect URI: the action of the form. */
  action: string;
  /** The authorization response parameters, one hidden field each. */
  fields: Record<string, string>;
}

export interface ErrorPageParams {
  /** Error message to display (OAuth error code for authorization errors) */
  error: string;
  /** Optional human-readable detail (OAuth error_description) */
  errorDescription?: string;
  /** HTTP status code */
  statusCode: number;
}

// ============================================================
// Views Interface
// ============================================================

/**
 * What a view returns: a JSX element. A component may be async, and markup
 * built elsewhere can be returned through hono/html — html`...` escapes its
 * interpolations, raw() trusts its string as is, so only hand it HTML that is
 * already escaped.
 */
export type ViewResult = JSX.Element;

/**
 * The views the views option of createApp() / applyOidc() may replace. A
 * feature adds the views of its screens to this interface, as optional
 * members (`declare module '../../views.js'` in its views.tsx), and falls back
 * to its own defaults for the ones left out.
 */
export interface Views {
  /** Render the login page (and login error page when error is set) */
  loginPage(params: LoginPageParams): ViewResult;
  /** Render the consent/authorization page */
  consentPage(params: ConsentPageParams): ViewResult;
  /** Render a generic error page */
  errorPage(params: ErrorPageParams): ViewResult;
  /** Render the auto-submitting form of a form_post authorization response */
  formPostPage(params: FormPostPageParams): ViewResult;
}

/** Options applied when renderView turns a view into a Response. */
export interface RenderViewInit {
  /** HTTP status code for the generated Response (defaults to 200). */
  status?: number;
  /**
   * Headers of the generated Response, set over the defaults
   * (Content-Type: text/html; charset=UTF-8 and Cache-Control: no-store).
   * Cookies are attached with withCookies() (pages/respond.ts) instead.
   */
  headers?: HeadersInit;
}

/**
 * Turn a rendered view into the text/html Response a page sends.
 *
 * The element is serialized to HTML here. One that contains an async component
 * serializes to a Promise; its HTML is streamed once it resolves, so the
 * Response (and the cookies a page attaches to it) is still built
 * synchronously.
 *
 * Every screen is rendered for the transaction or session of this browser's
 * cookie, at a URL that names neither (/login and /consent are the same URL for
 * every transaction). A stored copy would show one transaction's csrf_token,
 * login_hint or client to another browser or to a later flow, so by default the
 * page tells the browser and any intermediary not to store it (RFC 9111
 * §5.2.2.5). A screen with other caching rules passes its own Cache-Control in
 * init.headers.
 */
export function renderView(view: ViewResult, init?: RenderViewInit): Response {
  const html = serializeView(view);
  const headers = new Headers({ 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store' });
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  return new Response(typeof html === 'string' ? html : streamWhenResolved(html), {
    status: init?.status ?? 200,
    headers,
  });
}

/**
 * HTML of a view. JSX.Element is typed as a string, but at runtime a hono/jsx
 * element is an object that serializes through toString(), and an async
 * view is a Promise of one.
 */
function serializeView(view: ViewResult): string | Promise<string> {
  if (view instanceof Promise) {
    return view.then(serializeView);
  }
  return (view as { toString(): string | Promise<string> }).toString();
}

function streamWhenResolved(html: Promise<string>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode(await html));
      controller.close();
    },
  });
}

// ============================================================
// Building blocks of the default views
// ============================================================

/**
 * The HTML document every default view renders into. JSX has no syntax for the
 * doctype, so it is written with raw() — a fixed literal, never user input.
 */
export function Layout(props: { title: string; children?: Child }): JSX.Element {
  return (
    <>
      {raw('<!DOCTYPE html>')}
      <html>
        <head>
          <title>{props.title}</title>
        </head>
        <body>{props.children}</body>
      </html>
    </>
  );
}

/** The failure message of a form, with the attempts left when known. */
export function FormError(props: { error?: string; remainingAttempts?: number }): JSX.Element | null {
  if (!props.error) return null;
  return (
    <p style="color: red;">
      {props.error}
      {props.remainingAttempts !== undefined ? <>. Attempts remaining: {props.remainingAttempts}</> : null}
    </p>
  );
}

/** Username / password inputs shared by every sign-in form. */
export function CredentialFields(props: { username?: string }): JSX.Element {
  return (
    <>
      <div>
        <label for="username">Username:</label>
        <input type="text" id="username" name="username" value={props.username} required />
      </div>
      <div>
        <label for="password">Password:</label>
        <input type="password" id="password" name="password" required />
      </div>
    </>
  );
}

/** The scopes a client asked for, one list item each. */
export function ScopeList(props: { scopes: string[] }): JSX.Element {
  return (
    <ul>
      {props.scopes.map((scope) => (
        <li>{scope}</li>
      ))}
    </ul>
  );
}

/** The approve / deny result shown once the user decided. */
export function DecisionOutcome(props: { approved: boolean; clientId: string }): JSX.Element {
  return props.approved ? (
    <p>You approved <strong>{props.clientId}</strong>.</p>
  ) : (
    <p>You denied <strong>{props.clientId}</strong>.</p>
  );
}

// ============================================================
// Default Views Implementation
// Replace the components below to customize the UI.
// ============================================================

function defaultLoginPage(params: LoginPageParams): JSX.Element {
  // OIDC Core 1.0 §3.1.2.1: login_hint pre-fills the username. It is
  // unauthenticated input; the JSX attribute escapes it.
  return (
    <Layout title="Login">
      <h1>Login</h1>
      <FormError error={params.error} remainingAttempts={params.remainingAttempts} />
      <form method="post" action="/login">
        <input type="hidden" name="csrf_token" value={params.csrfToken} />
        <CredentialFields username={params.loginHint ?? ''} />
        <button type="submit">Login</button>
      </form>
      {(params.loginMethods ?? []).map((method) => (
        <>
          <hr />
          {method}
        </>
      ))}
    </Layout>
  );
}

// The submit buttons below carry the authorization decision (OIDC Core 1.0
// Section 3.1.2.4). The consent handler accepts exactly two values — 'approve'
// and 'deny' — and rejects everything else with 400, so customizing this markup
// must keep both button values as they are: renaming 'approve' makes every
// approval fail, and renaming 'deny' makes the Deny button rejected as well.
// See the validate-decision step of endpoints/consent/.
function defaultConsentPage(params: ConsentPageParams): JSX.Element {
  return (
    <Layout title="Consent">
      <h1>Authorize Application</h1>
      <p>Client <strong>{params.clientId}</strong> is requesting access to the following scopes:</p>
      <ScopeList scopes={params.scopes} />
      <form method="post" action="/consent">
        <input type="hidden" name="csrf_token" value={params.csrfToken} />
        <button type="submit" name="action" value="approve">Approve</button>
        <button type="submit" name="action" value="deny">Deny</button>
      </form>
    </Layout>
  );
}

function defaultErrorPage(params: ErrorPageParams): JSX.Element {
  return (
    <Layout title="Error">
      <h1>Error</h1>
      <p>{params.error}</p>
      {params.errorDescription ? <p>{params.errorDescription}</p> : null}
    </Layout>
  );
}

// OAuth 2.0 Form Post Response Mode §2: the action of the form MUST be the
// client's redirect URI and its method MUST be POST; any technique may submit
// it. The script submits it as soon as it is parsed (Appendix A does the same
// from body onload), and the button inside noscript lets a browser without
// JavaScript continue. The script is a fixed literal, never input.
function defaultFormPostPage(params: FormPostPageParams): JSX.Element {
  return (
    <Layout title="Submit This Form">
      <form method="post" action={params.action}>
        {Object.entries(params.fields).map(([name, value]) => (
          <input type="hidden" name={name} value={value} />
        ))}
        <noscript>
          <button type="submit">Continue</button>
        </noscript>
      </form>
      {raw('<script>document.forms[0].submit();</script>')}
    </Layout>
  );
}

/**
 * Default Views used when no custom views are injected.
 * These render minimal, unstyled HTML so the flow works out of the box.
 */
export const defaultViews: Views = {
  loginPage: defaultLoginPage,
  consentPage: defaultConsentPage,
  errorPage: defaultErrorPage,
  formPostPage: defaultFormPostPage,
};

/**
 * Build a Views instance, overriding any subset of the default views with your
 * own implementation. Inject the result through the provider options instead of
 * editing this file:
 *
 * @example
 * // Provide your own login UI while keeping the default consent/error pages.
 * createApp({
 *   signingKeyProvider,
 *   views: {
 *     loginPage: (params) => <MyLoginPage {...params} />,
 *   },
 * });
 */
export function createViews(overrides?: Partial<Views>): Views {
  if (!overrides) return defaultViews;
  return { ...defaultViews, ...overrides };
}
