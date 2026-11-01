import { resolveFormPostResponseContext } from '../../features/form-post-response-mode/steps/resolve-form-post-response-mode.js';
import { resolveRequestObject } from '../../features/request-object/steps/resolve-request-object.js';
import type { AuthorizationOutcome } from './outcome.js';
import type { AuthorizationResponseMode } from './response-mode.js';
import { completePromptNoneRequest } from './steps/authenticate-silently.js';
import { continueToLogin } from './steps/continue-to-login.js';
import { createAuthorizationTransaction } from './steps/create-transaction.js';
import { issueAuthorizationCodeResponse } from './steps/issue-authorization-code.js';
import { parseAuthorizationRequest } from './steps/parse-request.js';
import { resolveAuthorizationClient } from './steps/resolve-client.js';
import { resolveRedirectTarget } from './steps/resolve-redirect-uri.js';
import { authorizationErrorOutcome } from './steps/respond-error.js';
import { reuseExistingSession } from './steps/reuse-session.js';
import { rejectCombinedPromptNone } from './steps/validate-prompt-combination.js';
import { validateAuthorizationRequestParams } from './steps/validate-request.js';
import { verifyIdTokenHint } from './steps/verify-id-token-hint.js';

/**
 * Authorization endpoint (API layer: logic only).
 * OIDC Core 1.0 Section 3.1.2
 *
 * Each block of processAuthorizationRequest() calls one step (one box of
 * `maronn-oidc graph --detail steps --endpoint authorize`): parse the
 * request, resolve the client and the redirect_uri, validate the parameters,
 * create the transaction, verify id_token_hint, then try prompt=none and
 * Single Sign-On before continuing on the login screen. A block whose marker
 * names a feature belongs to that feature, and its step is in features/<id>/.
 *
 * The pipeline reports what the endpoint decided as an outcome: the
 * authorization response for the client, "continue on the login /
 * consent screen", or an error that must stay on the OP. It never builds a
 * Response; page.ts, which owns GET|POST /authorize, turns the outcome into
 * HTTP. A step that throws ends in authorizationErrorOutcome().
 */
export async function processAuthorizationRequest(c: any): Promise<AuthorizationOutcome> {
  // The response mode the request asked for, when a feature answers in one
  // (JARM, form_post, the fragment of the Implicit and Hybrid Flows). Set once
  // redirect_uri is verified, by the first block of a feature that answers
  // the request's response_mode or response_type (each assigns it only while
  // it is still unset); undefined means the plain query response. Declared
  // before the try block so the catch can answer in the mode the request
  // asked for.
  let responseMode: AuthorizationResponseMode | undefined;
  try {
    // RFC 9207 §2: include the issuer identifier on every authorization
    // response (success and error) so clients can pin the issuer that
    // produced the response.
    const issuer: string = c.get('config').issuer;

    // [parse-request] Parse the authorization request — OIDC Core 1.0 §3.1.2.1 / §13.2
    const parsed = await parseAuthorizationRequest(c);
    if ('kind' in parsed) return parsed;
    let params = parsed.params;

    // [resolve-client] Resolve the client — OAuth 2.1 §4.1.2.1 / RFC 8252 §8
    const client = await resolveAuthorizationClient(c, params);

    // [resolve-request-object] (feature: request-object) Verify the Request Object and overlay its claims — OIDC Core 1.0 §6.1
    const { effectiveParams, requestObjectClaims } = await resolveRequestObject(c, params, client);

    // [resolve-redirect-uri] Resolve redirect_uri (errors become redirectable) — OIDC Core 1.0 §3.1.2.1 / RFC 6749 §4.1.2.1
    const { redirectUri, state } = resolveRedirectTarget(effectiveParams ?? params, client);

    // [resolve-form-post-response-mode] (feature: form-post-response-mode) Interpret response_mode=form_post — OAuth 2.0 Form Post Response Mode §2
    responseMode ??= resolveFormPostResponseContext(effectiveParams ?? params, issuer);

    // [validate-request] Validate the request parameters — OIDC Core 1.0 §3.1.2.1-§3.1.2.2 / OAuth 2.1 §4.1.1 / §7.5
    const validatedRequest = await validateAuthorizationRequestParams(c, { params, effectiveParams, requestObjectClaims, client, redirectUri, state });

    // [create-transaction] Create and store the authorization transaction — OIDC Core 1.0 §3.1.2.3
    const { transactionId, transaction, transactionTtlSeconds } = await createAuthorizationTransaction(c, validatedRequest, responseMode);

    // [validate-prompt-combination] Reject prompt=none combined with other values — OIDC Core 1.0 §3.1.2.1
    // OIDC Core 1.0 Section 3.1.2.1: prompt is a space-delimited list
    const promptValues = transaction.prompt?.trim().split(/\s+/).filter(Boolean) ?? [];
    const promptCombinationError = await rejectCombinedPromptNone(c, promptValues, transactionId, transaction, issuer, responseMode);
    if (promptCombinationError) return promptCombinationError;

    // [verify-id-token-hint] Verify id_token_hint — OIDC Core 1.0 §3.1.2.1
    const hint = await verifyIdTokenHint(c, transactionId, transaction, issuer, responseMode);
    if ('kind' in hint) return hint;
    const { verifiedHintSubject } = hint;

    // [authenticate-silently] prompt=none: authenticate without interaction — OIDC Core 1.0 §3.1.2.1
    const silent = await completePromptNoneRequest(c, { promptValues, transactionId, transaction, verifiedHintSubject, issuer, responseMode });
    if (silent !== undefined) {
      if ('kind' in silent) return silent;
      return issueAuthorizationCodeResponse(c, { transactionId, transaction, session: silent.session, issuer, responseMode });
    }

    // [reuse-session] Single Sign-On: reuse the active OP session — OIDC Core 1.0 §3.1.2.3
    const sso = await reuseExistingSession(c, { promptValues, transactionId, transaction, transactionTtlSeconds, verifiedHintSubject });
    if (sso !== undefined) {
      if ('kind' in sso) return sso;
      return issueAuthorizationCodeResponse(c, { transactionId, transaction, session: sso.session, issuer, responseMode });
    }

    // [continue-to-login] Continue on the login screen — OIDC Core 1.0 §3.1.2.3
    return continueToLogin(transactionId, transactionTtlSeconds);
  } catch (error) {
    return authorizationErrorOutcome(c, error, responseMode);
  }
}
