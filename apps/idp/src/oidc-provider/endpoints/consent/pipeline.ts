import type { ConsentError, ConsentOutcome, ConsentScreen, ConsentSubmission } from './screen.js';
import { buildConsentRedirect } from './steps/build-authorization-response.js';
import { denyAuthorizationRequest } from './steps/deny-authorization.js';
import { describeConsentScreen } from './steps/describe-consent-screen.js';
import { issueConsentedAuthorizationCode } from './steps/issue-authorization-code.js';
import { loadTransaction } from './steps/load-transaction.js';
import { recordConsentDecision } from './steps/record-consent.js';
import { rejectCrossOriginFormPost } from './steps/reject-cross-origin-post.js';
import { requireAuthenticatedSubject } from './steps/require-authenticated-subject.js';
import { validateConsentCsrfToken } from './steps/validate-csrf-token.js';
import { validateConsentDecision } from './steps/validate-decision.js';

/**
 * Consent step (API layer: logic only).
 *
 * Everything the consent screen has to decide is a step (steps/), one box of
 * `maronn-oidc graph --detail steps --endpoint consent`: finding the
 * transaction through the transaction cookie (loadTransaction), the
 * csrf_token check (validateConsentCsrfToken), the scope policy and the form
 * (describeConsentScreen), the authorization decision
 * (validateConsentDecision, denyAuthorizationRequest), the authorization code
 * (issueConsentedAuthorizationCode), the consent record
 * (recordConsentDecision) and the authorization response
 * (buildConsentRedirect: RFC 6749 §4.1.2 / RFC 9207 iss, or the response mode
 * of a feature). A request of a response type a feature answers in place of
 * the code alone (the Implicit Flow, the Hybrid Flow) ends in that feature's
 * block instead of the code. None of them builds a Response — each returns an outcome,
 * and page.tsx turns that outcome into a screen or a redirect.
 * prepareConsent() (GET) and submitConsent() (POST) run them in the order the
 * screen needs, so the UI can be changed without touching this file.
 */

/**
 * GET /consent: load the transaction this browser's cookie names and describe
 * the form, or the error to show instead when there is none.
 */
export async function prepareConsent(c: any): Promise<ConsentScreen | ConsentError> {
  // [load-transaction] Load the transaction this browser is in
  const loaded = await loadTransaction(c);
  if ('kind' in loaded) return loaded;
  const { transactionId, transaction } = loaded;
  // [describe-consent-screen] Describe the consent form
  return describeConsentScreen(c, transactionId, transaction);
}

/**
 * POST /consent: record the decision and build the authorization response. The
 * steps run in the fixed order the screen needs (the consent endpoint of
 * `maronn-oidc graph --detail steps`).
 */
export async function submitConsent(c: any, input: ConsentSubmission): Promise<ConsentOutcome> {
  const { csrfToken, action } = input;

  // Checked before any decision is acted on: this step mints the authorization
  // code, so neither an approval nor a denial may come from anywhere else.
  // [reject-cross-origin-post] First the browser's own statement of where the
  // form was submitted from (isSameOriginFormPost() in cookies.ts): independent
  // of the cookie and the csrf_token, so a forged POST is stopped even if both
  // were planted.
  const sameOriginError = rejectCrossOriginFormPost(c);
  if (sameOriginError) return sameOriginError;

  // [load-transaction] The cookie says which transaction this browser is in.
  const loaded = await loadTransaction(c);
  if ('kind' in loaded) return loaded;
  const { transactionId, transaction } = loaded;

  // [validate-csrf-token] The csrf_token says the decision came from the form
  // the OP rendered for exactly that one.
  const csrfError = validateConsentCsrfToken(transaction, csrfToken);
  if (csrfError) return csrfError;

  // RFC 9207 §2: include the issuer identifier on every authorization response
  // (success and error) so clients can pin the issuer that produced the response.
  const issuer: string = c.get('config').issuer;

  // [deny-authorization] The End-User denied: answer access_denied — OIDC Core 1.0 §3.1.2.6
  if (action === 'deny') {
    return denyAuthorizationRequest(c, transactionId, transaction, issuer);
  }

  // [validate-decision] Accept only an affirmative decision — OIDC Core 1.0 §3.1.2.4
  const decisionError = validateConsentDecision(action);
  if (decisionError) return decisionError;

  // [require-authenticated-subject] The subject the login step stored
  const session = await requireAuthenticatedSubject(c, transactionId);
  if (!session) {
    return { kind: 'session_missing' };
  }

  // [issue-authorization-code] Issue the authorization code — OIDC Core 1.0 §3.1.2.5
  const { responseParams, authCodeData, grantedScope } = await issueConsentedAuthorizationCode(
    c,
    transactionId,
    transaction,
    session,
  );

  // [record-consent] Record the consent and the grant — OIDC Core 1.0 §3.1.2.4
  await recordConsentDecision(c, transactionId, transaction, session, authCodeData, grantedScope);

  // [build-authorization-response] Back to the client with the authorization code.
  return buildConsentRedirect(c, transaction, responseParams.redirectUri, {
    code: authCodeData.code,
    state: responseParams.state,
  }, issuer);
}
