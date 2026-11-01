import {
  type AuthorizationRequestParams,
  type ClientInfo,
  type ResolvedRequestObjectParams,
  AuthorizationError,
  AuthorizationErrorCode,
  rejectUnsupportedRequestParams,
  validateRequestObjectConsistency,
  validateResponseType,
  validateAuthorizationScope,
  validateClientScope,
  validateAuthorizationCodePkce,
  validatePromptParameter,
  applyOfflineAccessPolicy,
  validateDisplayParameter,
  resolveMaxAge,
  parseAudienceParameter,
  parseClaimsRequestParameter,
  validateAcrValuesParameter,
  responseTypeIncludes,
  type ValidatedAuthorizationRequest,
} from '@maronn-openid-connect/core';
import { features } from '../../../features/enabled.js';
import { tokenGrantsOf } from '../../../features/feature.js';
import { findUnsupportedScopes } from '../../../scopes.js';
import type { AuthorizationRequestInput } from '../outcome.js';
import { supportedResponseTypes } from '../response-type.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'validate-request',
  endpoint: 'authorize',
  kind: 'validate',
  label: 'Validate the request parameters',
  spec: 'OIDC Core 1.0 §3.1.2.1-§3.1.2.2 / OAuth 2.1 §4.1.1 / §7.5',
  function: 'validateAuthorizationRequestParams',
  calls: ['rejectUnsupportedRequestParams', 'validateRequestObjectConsistency', 'supportedResponseTypes', 'validateResponseType', 'validateAuthorizationScope', 'validateClientScope', 'responseTypeIncludes', 'validateAuthorizationCodePkce', 'validatePromptParameter', 'applyOfflineAccessPolicy', 'findUnsupportedScopes', 'validateDisplayParameter', 'resolveMaxAge', 'parseAudienceParameter', 'parseClaimsRequestParameter', 'validateAcrValuesParameter'],
  consumes: ['params', 'effectiveParams', 'requestObjectClaims', 'client', 'redirectUri', 'state'],
  optional: ['effectiveParams', 'requestObjectClaims'],
  produces: ['validatedRequest'],
  removable: false,
});

/**
 * Validate the authorization request parameters and assemble the validated
 * request. OIDC Core 1.0 §3.1.2.1 - §3.1.2.2 / OAuth 2.1 §4.1.1 / §7.5
 *
 * Each check is an independent core function, called in OIDC Core 1.0 §3.1.2
 * order. Delete a call to drop that validation, or insert your own logic
 * between two checks. Every failure here is redirectable (sent to the client
 * with the state), because redirect_uri was resolved before this step.
 */
export async function validateAuthorizationRequestParams(
  c: any,
  input: {
    /** The parameters as sent (OAuth query parameters). */
    params: AuthorizationRequestInput;
    /**
     * The parameters after the Request Object overlay (OIDC Core 1.0 §6.1).
     * undefined when the provider has no request-object feature: the query
     * parameters are then the request, and a `request` parameter is rejected
     * with request_not_supported (§6.3).
     */
    effectiveParams: AuthorizationRequestParams | undefined;
    requestObjectClaims: ResolvedRequestObjectParams['requestObjectClaims'];
    client: ClientInfo;
    redirectUri: string;
    state: string | undefined;
  },
): Promise<ValidatedAuthorizationRequest> {
  const { params, requestObjectClaims, client, redirectUri, state } = input;
  const effectiveParams = input.effectiveParams ?? params;
  const config = c.get('config');

  // OIDC Core 1.0 §6.3: request_uri / registration are not supported here, and
  // request only with the request-object feature, which resolved it already.
  rejectUnsupportedRequestParams(params, redirectUri, state, {
    requestParameterSupported: input.effectiveParams !== undefined,
  });

  // OIDC Core 1.0 §6.1: response_type / client_id inside the Request Object
  // must match the OAuth query parameters.
  validateRequestObjectConsistency(params, requestObjectClaims, redirectUri, state);

  // response_type: code, and the response types the features answer
  // (supportedResponseTypes() in response-type.ts), registered for the client.
  const responseType = validateResponseType(params, client, redirectUri, state, supportedResponseTypes());

  // scope must be in the query (OIDC Core 1.0 §6.1) and contain openid (§3.1.2.1).
  let scope = validateAuthorizationScope(params, effectiveParams, redirectUri, state);

  // RFC 7591 §2: a client registered with a scope list (client.scope) may only
  // request those scopes. Any other one, offline_access included, is invalid_scope.
  validateClientScope(scope, client.scope, redirectUri, state);

  // OAuth 2.1 §4.1.1 / §7.5: PKCE with S256 (allowNonPkceAuthorizationCodeFlow
  // exists only for the OIDF Basic OP static-client compatibility target).
  // PKCE binds the authorization code, so a response type that returns none
  // (the Implicit Flow, OIDC Core 1.0 §3.2) has nothing to bind.
  const pkce = responseTypeIncludes(responseType, 'code')
    ? validateAuthorizationCodePkce(effectiveParams, client, redirectUri, state, {
      allowNonPkceAuthorizationCodeFlow: config.allowNonPkceAuthorizationCodeFlow,
    })
    : { codeChallenge: undefined, codeChallengeMethod: undefined };

  // OIDC Core 1.0 §3.1.2.1: prompt is none|login|consent|select_account.
  const prompt = validatePromptParameter(effectiveParams, redirectUri, state);

  // offline_access は 2 つの独立した条件を両方満たしたときだけ残る。
  // - OIDC Core 1.0 §11: エンドユーザーの同意（prompt=consent）
  // - RFC 7591 §2: クライアント登録の grant_types に refresh_token があること
  //   （既定は ["authorization_code"]）。無いまま offline_access を通すと、発行した
  //   Refresh Token が unauthorized_client で拒否されるだけの死んだ資格情報になる。
  // どちらも、この OP が refresh_token grant を受け付ける（refresh-token 機能がある）
  // ときに限る。受け付けないなら offline_access は常に無視する（OIDC Core 1.0 §11）。
  // 認可コードを返さない response_type（Implicit Flow）の offline_access は、
  // applyOfflineAccessPolicy がコールバックに関わらず無視する（同 §11）。
  // 独自の許可条件を差し込むならコールバックを渡す（client も受け取れる）:
  //   scope = await applyOfflineAccessPolicy(scope, effectiveParams, prompt, client,
  //     (req, { promptValues }) => promptValues.includes('consent') || hasStoredConsent(req));
  const refreshTokensOffered = tokenGrantsOf(features).includes('refresh_token');
  scope = await applyOfflineAccessPolicy(
    scope,
    effectiveParams,
    prompt,
    client,
    refreshTokensOffered ? undefined : () => false,
  );

  // RFC 6749 §3.3 / §4.1.2.1: once custom scopes are declared (scopes.ts), a
  // value outside the allow list is rejected instead of being carried into
  // the grant. Placed AFTER applyOfflineAccessPolicy on purpose:
  // offline_access that the policy already dropped must stay "ignored"
  // (OIDC Core 1.0 §11) rather than turning the request into invalid_scope.
  const unsupportedScopes = findUnsupportedScopes(scope);
  if (unsupportedScopes.length > 0) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidScope,
      'Unsupported scope: ' + unsupportedScopes.join(' '),
      redirectUri,
      state,
    );
  }

  // OIDC Core 1.0 §3.1.2.1: display is page|popup|touch|wap.
  const display = validateDisplayParameter(effectiveParams, redirectUri, state);

  // OIDC Core 1.0 §3.1.2.1 / Dynamic Client Registration 1.0 §2: max_age from
  // the request, falling back to the client's registered default_max_age.
  const maxAge = resolveMaxAge(effectiveParams, client, redirectUri, state);

  // Space-delimited audience for the access token.
  const audience = parseAudienceParameter(effectiveParams);

  // OIDC Core 1.0 §5.5: parse the claims request parameter (userinfo / id_token).
  const claims = parseClaimsRequestParameter(effectiveParams, redirectUri, state);

  // OIDC Core 1.0 §3.1.2.1: acr_values is optional, space-separated acr values
  // in order of preference, each of visible ASCII characters other than " and \.
  // The token endpoint puts the acr it settles on into the ID Token and the
  // access token (the resolve-acr-amr step of endpoints/token/).
  const acrValues = validateAcrValuesParameter(effectiveParams, redirectUri, state);

  // Assemble the validated request from each step's result. This is core's
  // ValidatedAuthorizationRequest (what createAuthTransaction() takes), so
  // downstream code (transactions, authorization codes) is unaffected by
  // adding or removing steps above.
  const validatedRequest = {
    responseType,
    clientId: client.clientId,
    redirectUri,
    // OIDC Core 1.0 §3.1.3.2: when redirect_uri was sent explicitly, the token
    // request must repeat it; remember which case produced this authorization.
    redirectUriExplicit: effectiveParams.redirect_uri !== undefined,
    scope,
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: pkce.codeChallengeMethod,
    state,
    nonce: effectiveParams.nonce,
    prompt,
    display,
    maxAge,
    uiLocales: effectiveParams.ui_locales,
    claimsLocales: effectiveParams.claims_locales,
    acrValues,
    loginHint: effectiveParams.login_hint,
    idTokenHint: effectiveParams.id_token_hint,
    audience,
    claims,
  };
  return validatedRequest;
}
