#!/usr/bin/env node
/**
 * Prepares local development:
 * - apps/idp/.dev.vars: a signing key, the planner as a client, and the
 *   development users (testuser / otheruser, password "password")
 * - apps/planner/.dev.vars: the client secret of that client, the mock
 *   routine (scripts/mock-routine.mjs) as the routine to fire, and the hash of
 *   the routine's bearer token
 * - the bearer token itself in apps/planner/.dev.vars.mock-routine, where the
 *   mock's stand-in for the agent proxy reads it, as the real proxy reads the
 *   environment's network secret (secret type Bearer)
 * - the planner's D1 migrations on the local database (.wrangler/state)
 *
 * Existing values are kept, so running it again does not invalidate the
 * signing key or the client secret. Pass --reset to make new ones.
 */
import { join } from 'node:path';
import {
  IDP_DIR,
  LOCAL,
  PLANNER_DIR,
  generateSigningJwk,
  hashSecret,
  ok,
  plannerClient,
  randomSecret,
  readDevVars,
  wrangler,
  writeDevVars,
} from './lib.mjs';

const reset = process.argv.includes('--reset');
const idpVarsFile = join(IDP_DIR, '.dev.vars');
const plannerVarsFile = join(PLANNER_DIR, '.dev.vars');
const mockVarsFile = join(PLANNER_DIR, '.dev.vars.mock-routine');
const idpVars = reset ? {} : readDevVars(idpVarsFile);
const plannerVars = reset ? {} : readDevVars(plannerVarsFile);
const mockVars = reset ? {} : readDevVars(mockVarsFile);
const routineBearerToken = mockVars.ROUTINE_BEARER_TOKEN || randomSecret();

const clientSecret = plannerVars.OIDC_CLIENT_SECRET || randomSecret();
const signingKeys = idpVars.OIDC_SIGNING_KEYS || JSON.stringify([generateSigningJwk()]);

writeDevVars(idpVarsFile, {
  OIDC_SIGNING_KEYS: signingKeys,
  OIDC_CLIENTS_JSON: JSON.stringify([plannerClient(LOCAL.plannerOrigin, clientSecret)]),
  REGISTER_DEVELOPMENT_USERS: '1',
});
ok(`apps/idp/.dev.vars を書きました（開発用ユーザー: testuser / otheruser、パスワード: password）`);

writeDevVars(plannerVarsFile, {
  OIDC_CLIENT_SECRET: clientSecret,
  ROUTINE_FIRE_URL: plannerVars.ROUTINE_FIRE_URL || `${LOCAL.mockRoutineOrigin}/v1/claude_code/routines/trig_localmock/fire`,
  ROUTINE_TOKEN: plannerVars.ROUTINE_TOKEN || LOCAL.mockRoutineToken,
  ROUTINE_BEARER_TOKEN_HASH: hashSecret(routineBearerToken),
});
ok('apps/planner/.dev.vars を書きました（ルーチンはローカルのモックを指します）');

writeDevVars(mockVarsFile, {
  ROUTINE_BEARER_TOKEN: routineBearerToken,
  PLANNER_ORIGIN: LOCAL.plannerOrigin,
});
ok('apps/planner/.dev.vars.mock-routine を書きました（モックのルーチンが network secret の代わりに付ける Bearer トークン）');

wrangler(PLANNER_DIR, ['d1', 'migrations', 'apply', 'DB', '--local'], { input: '' });
ok('planner のローカル D1 にマイグレーションを適用しました');

console.log(`
次のコマンドで IdP（${LOCAL.idpOrigin}）、planner（${LOCAL.plannerOrigin}）、モックのルーチン（${LOCAL.mockRoutineOrigin}）を起動します。

  pnpm dev
`);
