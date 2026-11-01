/**
 * Scope policy for this provider.
 *
 * This module is the single place the generated provider asks its two scope
 * questions. It deliberately imports nothing, so both answers can be
 * rewritten — including against a database — without touching an endpoint.
 * The CLI writes CUSTOM_SCOPES from its `--scope` option.
 *
 * 1. "May this value be requested at all?" — `findUnsupportedScopes()`, called by
 *    the authorization endpoint (and by the device / CIBA request endpoints when
 *    those features are generated). Once a custom scope is declared, a value
 *    that is neither standard nor declared here is rejected with
 *    `invalid_scope` (RFC 6749 §3.3 / §4.1.2.1). Without one, any value is
 *    accepted.
 * 2. "May THIS End-User be granted it?" — `resolveGrantableScopes()`, called from
 *    every step that turns a request into a grant. **This is where per-user scope
 *    filtering goes**; see its doc comment below.
 *
 * Custom scopes carry no UserInfo claims of their own: OIDC Core 1.0 §5.4 defines
 * claims for profile / email / address / phone only, so `filterClaimsByScope()`
 * ignores them. Return your own claims for a custom scope by editing the
 * resolve-claims step of endpoints/userinfo/.
 */

/**
 * Scopes this provider implements itself and always accepts: `openid` (OIDC Core
 * 1.0 §3.1.2.1), the four claim scopes (§5.4) and `offline_access` (§11).
 */
export const STANDARD_SCOPES: readonly string[] = ['openid', 'profile', 'email', 'address', 'phone', 'offline_access'];

/** Declared with `--scope`: the custom scopes this provider accepts. */
export const CUSTOM_SCOPES: readonly string[] = [];

/**
 * OIDC Discovery 1.0 §3 `scopes_supported`: the scopes of OIDC Core and the
 * custom ones. offline_access is advertised by the refresh-token feature,
 * because only that feature grants it. It is OP metadata, so it lists what
 * the provider supports — not what a particular End-User ends up being
 * granted, which resolveGrantableScopes() decides.
 */
export const ADVERTISED_SCOPES: readonly string[] = ['openid', 'profile', 'email', 'address', 'phone', ...CUSTOM_SCOPES];

/**
 * Per-End-User scope restrictions, keyed by scope: only the listed subjects may
 * be granted that scope. Empty by default, so every accepted scope is grantable
 * to every authenticated End-User.
 *
 * This is the quickest way to restrict a scope — uncomment and fill in. For
 * anything richer (roles, tenants, a database), write it in
 * resolveGrantableScopes() below instead.
 */
export const RESTRICTED_SCOPE_SUBJECTS: Record<string, readonly string[]> = {
  // 'reports.read': ['testuser'],
};

/**
 * Narrow the requested scopes to what this End-User may actually be granted.
 *
 * **This is the per-user scope filtering seam.** It runs once the End-User is
 * known, and every step that decides a grant already awaits it:
 *
 * - the consent screen (what is displayed) and the approval (what is granted)
 * - the SSO fast path and prompt=none of the authorization endpoint, which
 *   grant without showing consent. Both narrow BEFORE looking up stored
 *   consent, because a consent lookup for a scope the subject can never hold
 *   would never match.
 * - the device and CIBA approval steps, when those features are generated
 *
 * It is async so a database / KV lookup can be dropped in without touching any
 * call site. `requested` also carries the standard scopes, so a policy may
 * narrow those too.
 *
 * Dropping a scope narrows the grant rather than failing the request: RFC 6749
 * §3.3 lets the authorization server issue a scope narrower than the one asked
 * for, and the token response reports the granted `scope`. To refuse the whole
 * request instead, throw from the call site that suits your flow.
 */
export async function resolveGrantableScopes(
  requested: readonly string[],
  subject: string,
): Promise<string[]> {
  return requested.filter((scope) => {
    const allowedSubjects = RESTRICTED_SCOPE_SUBJECTS[scope];
    return allowedSubjects === undefined || allowedSubjects.includes(subject);
  });
}

/**
 * Requested scopes this OP does not accept at all. A non-empty result means the
 * request must be rejected with `invalid_scope` (RFC 6749 §3.3). Until a custom
 * scope is declared there is no list to check against, and every value is
 * accepted.
 */
export function findUnsupportedScopes(requested: readonly string[]): string[] {
  if (CUSTOM_SCOPES.length === 0) return [];
  return requested.filter((scope) => !STANDARD_SCOPES.includes(scope) && !CUSTOM_SCOPES.includes(scope));
}
