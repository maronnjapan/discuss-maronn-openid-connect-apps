import {
  resolveAcrAmr,
  type AcrResolver,
  type ValidatedTokenRequest,
  selectPreferredAcr,
  selectRequestedAcrValues,
} from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'resolve-acr-amr',
  endpoint: 'token',
  kind: 'resolve',
  label: 'Resolve the acr / amr the tokens carry',
  spec: 'OIDC Core 1.0 §3.1.2.1 / §12.1 / RFC 9068 §2.2.1',
  function: 'resolveTokenAcrAmr',
  calls: ['selectRequestedAcrValues', 'resolveAcrAmr', 'selectPreferredAcr'],
  consumes: ['subject', 'validatedRequest'],
  produces: ['acr', 'amr'],
  removable: true,
  fallback: true,
});

/**
 * Resolve the acr / amr the tokens carry: the ID Token gets both, and the
 * access token gets the acr, so a resource server can tell how the End-User
 * authenticated (RFC 9068 §2.2.1).
 * OIDC Core 1.0 §2 / §3.1.2.1 / §12.1
 *
 * - authorization_code: the acrResolver option of the app decides from the
 *   acr values the client requested (acr_values, or claims.id_token.acr.values,
 *   OIDC Core 1.0 §5.5.1.1). Without an acrResolver the tokens carry the most
 *   preferred requested value and no amr, and no acr when none was requested.
 * - refresh_token: the acr / amr of the first authentication are kept
 *   (OIDC Core 1.0 §12.1); the resolver is not asked again.
 */
export async function resolveTokenAcrAmr(
  c: any,
  input: { subject: string; validatedRequest: ValidatedTokenRequest },
): Promise<{ acr: string | undefined; amr: string[] | undefined }> {
  const { subject, validatedRequest } = input;
  if (validatedRequest.grantType === 'refresh_token') {
    return { acr: validatedRequest.acr, amr: validatedRequest.amr };
  }

  // The requested acr values, in order of preference.
  const requestedAcrValues = selectRequestedAcrValues(validatedRequest.acrValues, validatedRequest.claims);

  const acrResolver = c.get('acrResolver') as AcrResolver | undefined;
  if (acrResolver !== undefined) {
    const { acr, amr } = await resolveAcrAmr({
      subject,
      clientId: validatedRequest.clientId,
      requestedAcrValues,
      acrResolver,
    });
    return { acr, amr };
  }

  // No acrResolver: the tokens carry the most preferred requested acr as it
  // is. This trusts the request; pass an acrResolver that reports the acr your
  // login actually satisfied before a resource server relies on it.
  return { acr: selectPreferredAcr(requestedAcrValues), amr: undefined };
}
