/**
 * The cookies of the provider and the origin check of its forms.
 *
 * - session_id: the browser (OP) session, OIDC Core 1.0 Section 3.1.2.3. It
 *   lasts across authorization requests and is what makes SSO, prompt=none
 *   and max_age work.
 * - __Host-oidc_txn: the authorization transaction this browser is in the
 *   middle of (Section 3.1.2.3 / 3.1.2.4).
 */
export const SESSION_COOKIE_NAME = 'session_id';

/**
 * Extract the session_id value from a Cookie request header.
 * Returns undefined when the header is missing or the cookie is absent.
 */
export function parseSessionId(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === SESSION_COOKIE_NAME) {
      return trimmed.slice(eq + 1);
    }
  }
  return undefined;
}

/**
 * Build the Set-Cookie value for the browser session.
 * Security attributes: HttpOnly (no JS access), Secure (HTTPS only),
 * SameSite=Lax. SameSite=Strict
 * would drop the cookie on the cross-site authorization redirect return and
 * break the flow, so Lax is required.
 */
export function buildSessionCookie(sessionId: string): string {
  return SESSION_COOKIE_NAME + '=' + sessionId + '; HttpOnly; Secure; SameSite=Lax; Path=/';
}

/**
 * Auth transaction cookie - which authorization request this browser is in the
 * middle of (OIDC Core 1.0 Section 3.1.2.3 / 3.1.2.4).
 *
 * /authorize hands the transaction id to the browser in this HttpOnly cookie
 * and nowhere else: the /login and /consent URLs carry no query, and their
 * forms embed only csrf_token. Every login / consent step reads the transaction
 * out of this cookie and accepts a submission only when the posted csrf_token
 * belongs to that transaction, so the cookie and the HTML have to come
 * together.
 *
 * Why not the URL: an id in the URL leaks through browser history, access logs
 * or a shared screen. Whoever picks it up could open the consent page, read
 * csrf_token off it and finish the flow; worse, an attacker could start a flow
 * with their OWN client and lure the victim to it, so that the victim's
 * authorization code is delivered to the attacker's client - a case the RP's
 * state check cannot catch. Neither works when the id only ever lives in a
 * cookie that page scripts cannot read and other sites cannot set.
 *
 * One cookie per browser: a second /authorize (another tab) replaces it, and a
 * form still open in the first tab is then refused - its csrf_token belongs to
 * the replaced transaction - instead of completing the wrong request.
 *
 * The '__Host-' prefix makes the browser refuse this cookie unless it comes
 * from this exact host with Secure, Path=/ and no Domain. Without it a sibling
 * subdomain (evil.example.com next to op.example.com) could plant its own
 * transaction in the victim's browser ("cookie tossing") - and the csrf_token
 * of that planted transaction is one the attacker already knows. Browsers
 * accept the prefix on http://localhost as well, so local development works.
 */
export const TRANSACTION_COOKIE_NAME = '__Host-oidc_txn';

/**
 * Build the Set-Cookie value that hands a transaction to this browser.
 * Same attributes as the session cookie: HttpOnly (no JS access), Secure
 * (HTTPS only; http://localhost is treated as trustworthy by browsers) and
 * SameSite=Lax, because SameSite=Strict would drop the cookie on the
 * cross-site navigation that starts the flow. Secure and Path=/ (and no
 * Domain) are also what the '__Host-' prefix requires. Max-Age matches the
 * transaction TTL so an abandoned flow does not leave the cookie behind.
 */
export function buildTransactionCookie(transactionId: string, ttlSeconds: number): string {
  return (
    TRANSACTION_COOKIE_NAME + '=' + transactionId +
    '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + String(ttlSeconds)
  );
}

/**
 * Build the Set-Cookie value that removes the transaction cookie once the
 * transaction is finished (code issued or access denied). It repeats Secure
 * and Path=/: the browser ignores a '__Host-' cookie write without them, the
 * removal included.
 */
export function buildClearedTransactionCookie(): string {
  return TRANSACTION_COOKIE_NAME + '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}

/**
 * Extract the transaction id from a Cookie request header.
 * Returns undefined when the header is missing or the cookie is absent.
 */
export function parseTransactionId(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === TRANSACTION_COOKIE_NAME) {
      return trimmed.slice(eq + 1) || undefined;
    }
  }
  return undefined;
}

/**
 * Whether a form POST to /login or /consent was sent from the OP's own pages.
 *
 * A check that depends on neither the transaction cookie nor the csrf_token:
 * the browser itself states where the request came from, and no page script
 * can override these headers. It still holds when a sibling subdomain managed
 * to plant a transaction cookie and therefore knows its csrf_token, and it is
 * the only check SameSite=Lax leaves to a same-site (sibling subdomain) POST.
 *
 * - Sec-Fetch-Site (Fetch Metadata): only 'same-origin' passes, plus 'none' -
 *   a user-initiated request such as a reload, which no other site can
 *   trigger. 'same-site' (a sibling subdomain) and 'cross-site' do not.
 * - Without Fetch Metadata, the Origin header a browser sends on every POST
 *   must be the issuer's origin. 'null' (an opaque origin) never matches.
 * - With neither header the request did not come from a browser page (curl, an
 *   HTTP client) or from a very old browser; the transaction cookie and the
 *   csrf_token still apply.
 *
 * The comparison uses config.issuer, never the request URL: some runtimes
 * derive the request URL from the Host header, which the sender controls.
 */
export function isSameOriginFormPost(
  headers: { origin: string | null; secFetchSite: string | null },
  issuer: string,
): boolean {
  if (headers.secFetchSite !== null) {
    return headers.secFetchSite === 'same-origin' || headers.secFetchSite === 'none';
  }
  if (headers.origin !== null) {
    return headers.origin === new URL(issuer).origin;
  }
  return true;
}

/** The message the OP shows when isSameOriginFormPost() refuses a form POST. */
export const CROSS_ORIGIN_FORM_POST_MESSAGE =
  'This form can only be submitted from the authorization server itself.';

/**
 * Build the Set-Cookie value that removes the browser session cookie. The
 * logout routes pair it with browserSessionStore.delete(): the store entry
 * and the cookie go away together (RP-Initiated Logout 1.0 §2).
 */
export function buildClearedSessionCookie(): string {
  return SESSION_COOKIE_NAME + '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}
