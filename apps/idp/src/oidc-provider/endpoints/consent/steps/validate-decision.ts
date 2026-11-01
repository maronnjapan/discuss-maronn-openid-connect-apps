import type { ConsentOutcome } from '../screen.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'validate-decision',
  endpoint: 'consent',
  kind: 'validate',
  label: 'Require an explicit approve decision',
  spec: 'OIDC Core 1.0 §3.1.2.4',
  function: 'validateConsentDecision',
  consumes: ['action'],
  produces: [],
  removable: false,
});

/**
 * [validate-decision] OIDC Core 1.0 Section 3.1.2.4: "the Authorization Server
 * MUST obtain an authorization decision before releasing information to the
 * Relying Party." The affirmative decision is therefore detected on an
 * allowlist: a missing, empty or unknown 'action' means no decision was
 * obtained, so it must not approve. Deciding by "not deny" would approve every
 * unexpected value instead.
 *
 * 'approve' is the decision value this provider accepts, and it MUST stay in
 * sync with the Approve button in views.tsx consentPage(). Changing it here
 * without changing the button (or the other way round) makes every approval
 * fail with the 400 page.tsx shows for this outcome.
 *
 * Section 3.1.2.6: access_denied means the End-User denied the request, which
 * is not the same as no decision at all — an unrecognized value stops here on
 * the OP's own error page instead of being redirected back to the client.
 */
export function validateConsentDecision(action: string): ConsentOutcome | undefined {
  return action === 'approve' ? undefined : { kind: 'invalid_decision' };
}
