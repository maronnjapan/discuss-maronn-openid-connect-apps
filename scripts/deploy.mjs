#!/usr/bin/env node
/**
 * Deploys the IdP and the planner to Cloudflare Workers, with everything they
 * need: D1 databases, schema and migrations, signing key, the planner's
 * client registration and secret, the routine's URL and token, the bearer
 * token the routine sends its results with, and a first user of the IdP.
 *
 *   pnpm run deploy                         # interactive
 *   pnpm run deploy --yes                   # non-interactive (values from env / previous run)
 *   pnpm run deploy --dry-run               # bundle both apps, change nothing on Cloudflare
 *
 * Before anything is created, the script shows how to set up the routine and
 * the cloud environment it runs in: the domains to allow, the network secret
 * that carries the routine's bearer token (secret type Bearer: the agent
 * proxy adds it to the requests for the planner), and the prompt to save in
 * the routine. It then asks for the URL and token of the routine's API
 * trigger and for the bearer token (the Value of the network secret), and
 * the deployment starts only after they are entered and confirmed.
 *
 * Those three values are asked for on every interactive run, so they can be
 * changed on an update too; an empty answer keeps the registered value. The
 * planner keeps only the hash of the bearer token.
 *
 * These settings live on claude.ai, and the environment's network access,
 * its network secrets and the API token can only be set in its web UI (there
 * is no API or CLI for them), so they are shown as steps to follow rather
 * than automated. When a value there changes (a new client secret, another
 * URL, the domains, the prompt, the bearer token), the next run shows the
 * steps to redo.
 *
 * Options:
 *   --idp-name <name> / --planner-name <name>      Worker names (default maronn-idp / maronn-planner)
 *   --idp-origin <url> / --planner-origin <url>    custom domains instead of workers.dev
 *   --allowed-subs <a,b>                            users allowed to use the planner (default: all)
 *   --routine                                       show every step of the routine's setup before the input
 *   --rotate-client-secret                          issue a new client secret for the planner
 *   --rotate-signing-key                            replace the IdP's signing key
 *   --skip-user                                     do not offer to create a user
 *
 * Environment variables (used instead of prompts):
 *   ROUTINE_FIRE_URL, ROUTINE_TOKEN, ROUTINE_BEARER_TOKEN
 *   ADMIN_USER_ID, ADMIN_USER_NAME, ADMIN_USER_EMAIL, ADMIN_USER_PASSWORD
 *
 * Running it again is safe and is how code, settings and secrets are updated:
 * existing databases are reused, and secrets that are already set are kept
 * unless asked to replace them (or, for the routine's values, unless new
 * ones are entered). What was resolved is kept in
 * .deploy/state.json, and each app's wrangler.deploy.jsonc holds its real
 * resource ids (both gitignored).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  CLIENT_ID,
  IDP_DIR,
  PLANNER_DIR,
  ROOT,
  ask,
  closePrompts,
  confirm,
  generateSigningJwk,
  hashSecret,
  log,
  ok,
  plannerClient,
  randomSecret,
  run,
  runStreaming,
  warn,
  wrangler,
} from './lib.mjs';
import { loadState, saveState, stripJsonComments } from './state.mjs';
import { changeReasons, formatRoutineGuide, hasChanges, routineSetupChanges, routineSetupValues } from './routine-guide.mjs';

// Show what went wrong without a stack trace; the steps above say where it stopped.
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (error) => {
    console.error(`\x1b[31m✘\x1b[0m ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}

const { values: options } = parseArgs({
  options: {
    yes: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'idp-name': { type: 'string' },
    'planner-name': { type: 'string' },
    'idp-origin': { type: 'string' },
    'planner-origin': { type: 'string' },
    'allowed-subs': { type: 'string' },
    routine: { type: 'boolean', default: false },
    'rotate-client-secret': { type: 'boolean', default: false },
    'rotate-signing-key': { type: 'boolean', default: false },
    'skip-user': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (options.help) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n?/, '').replace(/^ \* ?/gm, ''));
  process.exit(0);
}

const interactive = process.stdin.isTTY && !options.yes;
const dryRun = options['dry-run'];
const state = loadState();

// ---------------------------------------------------------------------------
// Helpers

function trimOrigin(value) {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error(`${value} は https:// の URL にしてください。`);
  return url.origin;
}

function readBaseConfig(appDir) {
  return JSON.parse(stripJsonComments(readFileSync(join(appDir, 'wrangler.jsonc'), 'utf8')));
}

function writeDeployConfig(appDir, config) {
  const header = '// Generated by scripts/deploy.mjs from wrangler.jsonc. Do not edit; do not commit.\n';
  writeFileSync(join(appDir, 'wrangler.deploy.jsonc'), header + JSON.stringify(config, null, 2) + '\n');
}

function deployArgs(appDir) {
  return ['--config', join(appDir, 'wrangler.deploy.jsonc')];
}

/** A domain route for a custom origin, or workers.dev. */
function routing(origin, workersDevOrigin) {
  if (origin && origin !== workersDevOrigin) {
    return { workers_dev: false, routes: [{ pattern: new URL(origin).host, custom_domain: true }] };
  }
  return { workers_dev: true };
}

/** The names of the secrets a Worker has (empty when the Worker does not exist yet). */
function secretNames(appDir, workerName, accountId) {
  const result = wrangler(appDir, ['secret', 'list', '--name', workerName, '--format', 'json'], {
    allowFailure: true,
    input: '',
    env: { CLOUDFLARE_ACCOUNT_ID: accountId },
  });
  if (result.status !== 0) return new Set();
  try {
    return new Set(JSON.parse(result.stdout).map((secret) => secret.name));
  } catch {
    return new Set();
  }
}

/**
 * The account's workers.dev subdomain, read from the Cloudflare API with the
 * token wrangler is signed in with. Undefined when the account has none yet
 * (the first deploy then asks to register one).
 */
async function fetchWorkersDevSubdomain(accountId) {
  try {
    const { token } = JSON.parse(wrangler(IDP_DIR, ['auth', 'token', '--json'], { input: '' }).stdout);
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await response.json();
    return response.ok && body.success ? body.result?.subdomain || undefined : undefined;
  } catch {
    return undefined;
  }
}

function withSecretsFile(secrets, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-secrets-'));
  const file = join(dir, 'secrets.json');
  writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  return Promise.resolve(fn(file)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

async function deployWorker(appDir, secrets) {
  const args = ['exec', 'wrangler', 'deploy', ...deployArgs(appDir)];
  if (dryRun) {
    return runStreaming('pnpm', [...args, '--dry-run', '--outdir', join(appDir, 'dist')], { cwd: appDir });
  }
  if (Object.keys(secrets).length === 0) return runStreaming('pnpm', args, { cwd: appDir });
  return withSecretsFile(secrets, (file) => runStreaming('pnpm', [...args, '--secrets-file', file], { cwd: appDir }));
}

function workersDevUrl(output, workerName) {
  const match = new RegExp(`https://${workerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.([a-z0-9-]+)\\.workers\\.dev`).exec(output);
  return match ? { origin: match[0], subdomain: match[1] } : null;
}

function ensureDatabase(name) {
  const list = () => JSON.parse(wrangler(IDP_DIR, ['d1', 'list', '--json'], { input: '' }).stdout);
  let database = list().find((db) => db.name === name);
  if (!database) {
    log(`D1 データベース ${name} を作成します`);
    wrangler(IDP_DIR, ['d1', 'create', name], { input: '' });
    database = list().find((db) => db.name === name);
    if (!database) throw new Error(`D1 データベース ${name} を作成できませんでした。`);
    ok(`D1 データベース ${name} を作成しました（${database.uuid}）`);
  } else {
    ok(`D1 データベース ${name} を再利用します（${database.uuid}）`);
  }
  return database.uuid;
}

async function waitForJson(url, check, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (response.ok) {
        const body = await response.json();
        if (check(body)) return body;
        last = JSON.stringify(body).slice(0, 200);
      } else {
        last = `HTTP ${response.status}`;
      }
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`${url} の応答を確認できませんでした（最後の結果: ${last}）。`);
}

// The fire URL the API trigger dialog shows (platform.claude.com/docs/en/api/claude-code/routines-fire).
const FIRE_URL_PATTERN = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9]+\/fire$/;
const TOKEN_PATTERN = /^sk-ant-oat01-\S+$/;

/** Problems with a fire URL: an error that stops, or a warning to confirm. */
function checkFireUrl(value) {
  if (!value) return { error: 'URL を入力してください。' };
  if (/\s/.test(value)) return { error: 'URL に空白が含まれています。' };
  if (FIRE_URL_PATTERN.test(value)) return {};
  if (/^https:\/\/\S+\/fire$/.test(value)) {
    return { warning: `想定している形（https://api.anthropic.com/v1/claude_code/routines/trig_…/fire）と異なります。` };
  }
  return { error: 'https:// で始まり /fire で終わる、API トリガーの URL を入力してください。' };
}

function checkToken(value) {
  if (!value) return { error: 'トークンを入力してください。' };
  if (/\s/.test(value)) return { error: 'トークンに空白が含まれています。' };
  if (TOKEN_PATTERN.test(value)) return {};
  return { warning: 'トークンが sk-ant-oat01- で始まっていません。' };
}

/** The Value of the network secret: sent as a header, so printable ASCII without spaces. */
function checkBearerToken(value) {
  if (!value) return { error: 'トークンを入力してください。' };
  if (/\s/.test(value)) return { error: 'トークンに空白が含まれています。' };
  if (/[^\x21-\x7e]/.test(value)) return { error: 'トークンは ASCII の印字可能文字（空白を除く）にしてください。' };
  if (value.length < 32) return { warning: `トークンが ${value.length} 文字です。推測されにくい 32 文字以上の値を勧めます。` };
  return {};
}

function maskToken(token) {
  return token.length > 18 ? `${token.slice(0, 13)}…${token.slice(-4)}` : '（入力済み）';
}

/**
 * Asks for a value that goes to the planner as a secret, until it passes the
 * check; a warning is accepted only when confirmed. When a value is
 * registered, an empty answer keeps it (undefined is returned).
 */
async function askSecretValue(question, check, { registered, hidden = false }) {
  const notes = [hidden && '入力は表示されません', registered && '空のまま Enter で登録済みの値を使います'].filter(Boolean);
  const label = notes.length > 0 ? `${question}（${notes.join('。')}）` : question;
  for (;;) {
    const value = (await ask(label, { secret: hidden })).trim();
    if (!value && registered) return undefined;
    const { error, warning } = check(value);
    if (error) {
      warn(error);
      continue;
    }
    if (warning) {
      warn(warning);
      if (!(await confirm('このまま使いますか？', false))) continue;
    }
    return value;
  }
}

/** A value from an environment variable, checked like an entered one. */
function fromEnv(name, check) {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  const { error, warning } = check(value);
  if (error) throw new Error(`${name}: ${error}`);
  if (warning) warn(`${name}: ${warning}`);
  return value;
}

// ---------------------------------------------------------------------------
// 1. Cloudflare account

log('Cloudflare へのログインを確認します');
let whoami = wrangler(IDP_DIR, ['whoami', '--json'], { allowFailure: true, input: '' });
if (whoami.status !== 0) {
  if (!interactive) throw new Error('wrangler にログインしていません。`pnpm --filter @apps/idp exec wrangler login` を実行してください。');
  await runStreaming('pnpm', ['exec', 'wrangler', 'login'], { cwd: IDP_DIR });
  whoami = wrangler(IDP_DIR, ['whoami', '--json'], { input: '' });
}
const account = JSON.parse(whoami.stdout);
let accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? state.accountId;
if (!accountId || !account.accounts.some((a) => a.id === accountId)) {
  if (account.accounts.length === 1 || !interactive) {
    accountId = account.accounts[0].id;
  } else {
    account.accounts.forEach((a, index) => console.log(`  ${index + 1}. ${a.name} (${a.id})`));
    const choice = Number(await ask('デプロイ先のアカウントの番号', { defaultValue: '1' }));
    accountId = account.accounts[choice - 1]?.id ?? account.accounts[0].id;
  }
}
ok(`アカウント: ${account.accounts.find((a) => a.id === accountId)?.name ?? accountId}（${account.email}）`);

// ---------------------------------------------------------------------------
// 2. Names and origins

const idpName = options['idp-name'] ?? state.idp?.name ?? (interactive ? await ask('IdP の Worker 名', { defaultValue: 'maronn-idp' }) : 'maronn-idp');
const plannerName =
  options['planner-name'] ?? state.planner?.name ?? (interactive ? await ask('planner の Worker 名', { defaultValue: 'maronn-planner' }) : 'maronn-planner');
const customIdpOrigin = trimOrigin(options['idp-origin']) ?? state.idp?.customOrigin;
const customPlannerOrigin = trimOrigin(options['planner-origin']) ?? state.planner?.customOrigin;
const allowedSubs = options['allowed-subs'] ?? state.allowedSubs ?? '';
let subdomain = state.accountId === accountId ? state.workersDevSubdomain : undefined;
if (!subdomain && !(customIdpOrigin && customPlannerOrigin)) {
  subdomain = await fetchWorkersDevSubdomain(accountId);
}

const origins = () => {
  const idpWorkersDev = subdomain ? `https://${idpName}.${subdomain}.workers.dev` : undefined;
  const plannerWorkersDev = subdomain ? `https://${plannerName}.${subdomain}.workers.dev` : undefined;
  return {
    idpWorkersDev,
    plannerWorkersDev,
    idp: customIdpOrigin ?? idpWorkersDev,
    planner: customPlannerOrigin ?? plannerWorkersDev,
  };
};

if (origins().planner) {
  ok(`planner の URL: ${origins().planner}`);
} else {
  warn('workers.dev のサブドメインがまだ登録されていません。デプロイの途中で登録を求められます。');
}

// ---------------------------------------------------------------------------
// 3. The routine and its environment, set up on claude.ai before anything is
//    deployed: the environment it runs in with its network secret (the bearer
//    token the agent proxy adds to the requests for the planner), and the URL
//    and token of its API trigger. They can only be set in claude.ai's web
//    UI, so the script shows the steps (scripts/routine-guide.mjs), and shows
//    again the ones to redo when a value there changes.
//
//    The three values the planner keeps as secrets (the trigger's URL and
//    token, and the bearer token) are asked for on every interactive run, and
//    an empty answer keeps the registered value. Cloudflare does not give
//    secrets back, so the registered values cannot be shown.

const idpSecrets = dryRun ? new Set() : secretNames(IDP_DIR, idpName, accountId);
const plannerSecrets = dryRun ? new Set() : secretNames(PLANNER_DIR, plannerName, accountId);
const registered = {
  fireUrl: plannerSecrets.has('ROUTINE_FIRE_URL'),
  token: plannerSecrets.has('ROUTINE_TOKEN'),
  bearerToken: plannerSecrets.has('ROUTINE_BEARER_TOKEN_HASH'),
};
const entered = {
  fireUrl: fromEnv('ROUTINE_FIRE_URL', checkFireUrl),
  token: fromEnv('ROUTINE_TOKEN', checkToken),
  bearerToken: fromEnv('ROUTINE_BEARER_TOKEN', checkBearerToken),
};
const fromEnvironment = { fireUrl: entered.fireUrl !== undefined, token: entered.token !== undefined, bearerToken: entered.bearerToken !== undefined };
const LABELS = { fireUrl: 'API トリガーの URL', token: 'API トリガーのトークン', bearerToken: 'Bearer トークン（network secret の Value）' };

// The planner and .deploy/state.json keep only the hash of the bearer token.
const bearerTokenHash = () => (entered.bearerToken ? hashSecret(entered.bearerToken) : state.routineBearerTokenHash);
// Until the workers.dev subdomain is known, the guide uses a placeholder (it must parse as a URL).
const guidePlannerOrigin = origins().planner ?? `https://${plannerName}.your-subdomain.workers.dev`;
const guideValues = () => routineSetupValues({ plannerOrigin: guidePlannerOrigin, bearerTokenHash: bearerTokenHash() });
const setupChanges = () => routineSetupChanges({ previous: state.routineSetup, current: guideValues().fingerprints });
// A setup from before the network secret of type Bearer (client credentials at the IdP).
const migrating = state.routineClientSecretHash !== undefined || idpSecrets.has('OIDC_SERVICE_CLIENTS_JSON');
let routineSetupConfirmed = false;

/** Prints every step (full) or the ones to redo; wait: the user finishes them before the deployment goes on. */
function printEnvironmentGuide({ full, wait }) {
  mkdirSync(join(ROOT, '.deploy'), { recursive: true });
  const promptFile = join(ROOT, '.deploy/routine-prompt.md');
  const values = guideValues();
  writeFileSync(promptFile, values.prompt + '\n');
  const changes = setupChanges();
  const tokenValue = entered.bearerToken
    ? fromEnvironment.bearerToken
      ? '環境変数 ROUTINE_BEARER_TOKEN の値'
      : '入力した値'
    : registered.bearerToken
      ? '前回と同じ値（控えていなければ新しい値にして、このあとの入力でも同じ値を入れる）'
      : `推測されにくい長いランダムな文字列（このあとの入力でも同じ値を入れる）。例: ${randomSecret()}`;
  const setUpBefore = state.routineSetup !== undefined || migrating;
  const reasons =
    !full && setUpBefore
      ? changeReasons({
          changes,
          migrating,
          unrecorded: state.routineSetup === undefined,
          tokenChanged: bearerTokenHash() !== state.routineBearerTokenHash,
        })
      : [];
  console.log(formatRoutineGuide({ values, changes, full, wait, reasons, tokenValue, promptFile }));
  if (!origins().planner) {
    warn('planner の URL はデプロイ後に確定します（上の your-subdomain の部分）。次回のデプロイで、確定した URL で直す手順を表示します。');
  }
}

if (!interactive && !dryRun) {
  const missing = Object.keys(registered)
    .filter((key) => !registered[key] && !entered[key])
    .map((key) => ({ fireUrl: 'ROUTINE_FIRE_URL', token: 'ROUTINE_TOKEN', bearerToken: 'ROUTINE_BEARER_TOKEN' })[key]);
  if (missing.length > 0) {
    throw new Error(`${missing.join('、')} が未登録です。環境変数で渡すか、対話モードで実行してください（何も作成していません）。`);
  }
}

if (interactive) {
  // A routine being set up (or --routine): every step first, then the values.
  const full = !registered.fireUrl || !registered.token || !registered.bearerToken || options.routine;
  if (full) printEnvironmentGuide({ full: true, wait: true });
  for (;;) {
    if (!fromEnvironment.fireUrl) entered.fireUrl = await askSecretValue(LABELS.fireUrl, checkFireUrl, { registered: registered.fireUrl });
    if (!fromEnvironment.token) {
      entered.token = await askSecretValue(LABELS.token, checkToken, { registered: registered.token, hidden: true });
    }
    if (!fromEnvironment.bearerToken) {
      entered.bearerToken = await askSecretValue(LABELS.bearerToken, checkBearerToken, { registered: registered.bearerToken, hidden: true });
    }
    const anyEntered = Object.values(entered).some((value) => value !== undefined);
    if (!anyEntered && !full) break;
    const shown = {
      fireUrl: entered.fireUrl,
      token: entered.token && maskToken(entered.token),
      bearerToken: entered.bearerToken && `（入力済み、${entered.bearerToken.length} 文字）`,
    };
    console.log(
      `\n${Object.keys(LABELS)
        .map((key) => `  ${LABELS[key]}  ${shown[key] ?? '登録済みの値をそのまま使う'}`)
        .join('\n')}\n`,
    );
    if (await confirm('この内容で登録してデプロイを始めますか？', true)) break;
  }
  if (full) routineSetupConfirmed = true;
}

if (hasChanges(setupChanges()) && !routineSetupConfirmed && !dryRun) {
  printEnvironmentGuide({ full: false, wait: interactive });
  if (interactive) {
    if (!(await confirm('claude.ai で上の設定を済ませましたか？ デプロイを始めます', true))) {
      throw new Error('中止しました（何も作成していません）。');
    }
    routineSetupConfirmed = true;
  } else {
    warn('非対話で実行しているため、claude.ai の設定を確かめずに進めます。設定を済ませた後で `pnpm run deploy` を対話モードで一度実行すると、この表示は出なくなります。');
  }
}
for (const key of Object.keys(LABELS)) {
  if (entered[key]) ok(`${LABELS[key]}を${fromEnvironment[key] ? '環境変数から' : ''}受け取りました`);
  else if (registered[key]) ok(`登録済みの${LABELS[key]}を使います`);
  else warn(`dry-run: ${LABELS[key]}は未入力のまま進めます`);
}

// ---------------------------------------------------------------------------
// 4. Databases

const idpDatabase = state.idp?.database ?? idpName;
const plannerDatabase = state.planner?.database ?? plannerName;
const idpDatabaseId = dryRun ? state.idp?.databaseId ?? '00000000-0000-0000-0000-000000000000' : ensureDatabase(idpDatabase);
const plannerDatabaseId = dryRun ? state.planner?.databaseId ?? '00000000-0000-0000-0000-000000000000' : ensureDatabase(plannerDatabase);

function writeIdpConfig() {
  const base = readBaseConfig(IDP_DIR);
  const { idp, idpWorkersDev } = origins();
  delete base.dev;
  writeDeployConfig(IDP_DIR, {
    ...base,
    name: idpName,
    account_id: accountId,
    ...routing(idp, idpWorkersDev),
    vars: { ...base.vars, ISSUER: idp ?? 'https://issuer-not-resolved-yet.invalid' },
    d1_databases: [{ ...base.d1_databases[0], database_name: idpDatabase, database_id: idpDatabaseId }],
  });
}

function writePlannerConfig() {
  const base = readBaseConfig(PLANNER_DIR);
  const { idp, planner, plannerWorkersDev } = origins();
  delete base.dev;
  writeDeployConfig(PLANNER_DIR, {
    ...base,
    name: plannerName,
    account_id: accountId,
    ...routing(planner, plannerWorkersDev),
    vars: { ...base.vars, APP_ORIGIN: planner, OIDC_ISSUER: idp, OIDC_CLIENT_ID: CLIENT_ID, ALLOWED_SUBS: allowedSubs },
    // The back-channel requests to the IdP (discovery, token, userinfo, JWKS) go over a service binding.
    services: [{ binding: 'IDP', service: idpName }],
    d1_databases: [{ ...base.d1_databases[0], database_name: plannerDatabase, database_id: plannerDatabaseId }],
  });
}

// ---------------------------------------------------------------------------
// 5. Without a registered workers.dev subdomain: deploy the IdP once to get one

if (!subdomain && !(customIdpOrigin && customPlannerOrigin)) {
  if (dryRun) {
    subdomain = 'your-subdomain';
    warn('dry-run: workers.dev のサブドメインが未確定なので your-subdomain として設定を書きます');
  } else {
    log('workers.dev の URL を確定させるため、IdP を一度デプロイします');
    writeIdpConfig();
    const output = await deployWorker(IDP_DIR, {});
    const url = workersDevUrl(output, idpName);
    if (!url) throw new Error('デプロイ結果から workers.dev の URL を読み取れませんでした。--idp-origin と --planner-origin を指定してください。');
    subdomain = url.subdomain;
    ok(`workers.dev のサブドメイン: ${subdomain}`);
  }
}

const { idp: idpOrigin, planner: plannerOrigin } = origins();
writeIdpConfig();
writePlannerConfig();
ok(`IdP: ${idpOrigin}`);
ok(`planner: ${plannerOrigin}`);

// ---------------------------------------------------------------------------
// 6. Secrets

const idpSecretValues = {};
const plannerSecretValues = {};

if (!idpSecrets.has('OIDC_SIGNING_KEYS') || options['rotate-signing-key']) {
  idpSecretValues.OIDC_SIGNING_KEYS = JSON.stringify([generateSigningJwk()]);
  log(idpSecrets.has('OIDC_SIGNING_KEYS') ? '署名鍵を新しくします（発行済みのトークンは検証できなくなります）' : '署名鍵を生成します');
}

const clientFingerprint = createHash('sha256').update(JSON.stringify(plannerClient(plannerOrigin, ''))).digest('hex');
if (
  !idpSecrets.has('OIDC_CLIENTS_JSON') ||
  !plannerSecrets.has('OIDC_CLIENT_SECRET') ||
  state.clientFingerprint !== clientFingerprint ||
  options['rotate-client-secret']
) {
  const clientSecret = randomSecret();
  idpSecretValues.OIDC_CLIENTS_JSON = JSON.stringify([plannerClient(plannerOrigin, clientSecret)]);
  plannerSecretValues.OIDC_CLIENT_SECRET = clientSecret;
  log('planner のクライアント登録とクライアントシークレットを設定します');
}

if (entered.fireUrl) plannerSecretValues.ROUTINE_FIRE_URL = entered.fireUrl;
if (entered.token) plannerSecretValues.ROUTINE_TOKEN = entered.token;
if (entered.bearerToken) plannerSecretValues.ROUTINE_BEARER_TOKEN_HASH = hashSecret(entered.bearerToken);
const changedRoutineValues = Object.keys(LABELS).filter((key) => entered[key]);
if (changedRoutineValues.length > 0) {
  log(`${changedRoutineValues.map((key) => LABELS[key]).join('、')}を planner の Secret に登録します（Bearer トークンはハッシュだけ）`);
}

// ---------------------------------------------------------------------------
// 7. Database schemas

if (!dryRun) {
  log('IdP のテーブルを作成します（既存のテーブルはそのまま）');
  wrangler(IDP_DIR, ['d1', 'execute', 'DB', '--remote', '--yes', '--file', 'src/oidc-provider/db/schema.sql', ...deployArgs(IDP_DIR)], { input: '' });
  log('planner のマイグレーションを適用します');
  wrangler(PLANNER_DIR, ['d1', 'migrations', 'apply', 'DB', '--remote', ...deployArgs(PLANNER_DIR)], { input: '' });
  ok('データベースの準備ができました');
}

// ---------------------------------------------------------------------------
// 8. Deploy

log(`IdP（${idpName}）をデプロイします`);
await deployWorker(IDP_DIR, idpSecretValues);
log(`planner（${plannerName}）をデプロイします`);
await deployWorker(PLANNER_DIR, plannerSecretValues);

// Leftovers of the client credentials grant the routine used before the
// Bearer network secret: the IdP's secret with the routine's client, and the
// client's rows in D1 with the tokens it was issued. The IdP deployed above
// no longer reads them; deleting the secret deploys it once more without it.
if (!dryRun && idpSecrets.has('OIDC_SERVICE_CLIENTS_JSON')) {
  log('IdP からルーチン用クライアント（client credentials）を削除します');
  wrangler(IDP_DIR, ['secret', 'delete', 'OIDC_SERVICE_CLIENTS_JSON', ...deployArgs(IDP_DIR)], { input: 'y\n' });
  const serviceClientIds = "SELECT client_id FROM client_grant_types WHERE grant_type = 'client_credentials'";
  const statements = [
    `DELETE FROM access_tokens WHERE client_id IN (${serviceClientIds})`,
    `DELETE FROM client_secrets WHERE id IN (SELECT id FROM client_auths WHERE client_id IN (${serviceClientIds}))`,
    ...['client_auths', 'client_scopes', 'client_redirect_uris', 'client_response_types', 'client_jwks'].map(
      (table) => `DELETE FROM ${table} WHERE client_id IN (${serviceClientIds})`,
    ),
    `DELETE FROM clients WHERE id IN (${serviceClientIds})`,
    // Gone with the clients when foreign keys cascade; otherwise here.
    "DELETE FROM client_grant_types WHERE grant_type = 'client_credentials'",
  ];
  wrangler(IDP_DIR, ['d1', 'execute', 'DB', '--remote', '--yes', '--command', `${statements.join('; ')};`, ...deployArgs(IDP_DIR)], {
    input: '',
  });
  ok('IdP のルーチン用クライアント（Secret の OIDC_SERVICE_CLIENTS_JSON と D1 の登録、発行済みのトークン）を削除しました');
}

if (dryRun) {
  // The configs of a dry run may carry placeholder ids, which other commands
  // (user add --remote) would otherwise pick up.
  for (const dir of [IDP_DIR, PLANNER_DIR]) {
    rmSync(join(dir, 'wrangler.deploy.jsonc'), { force: true });
    rmSync(join(dir, 'dist'), { recursive: true, force: true });
  }
  ok('dry-run: 両アプリのバンドルを確認しました（Cloudflare 上は何も変えていません）');
  closePrompts();
  process.exit(0);
}

saveState({
  accountId,
  workersDevSubdomain: subdomain,
  allowedSubs,
  clientFingerprint,
  routineBearerTokenHash: bearerTokenHash(),
  // What is set up on claude.ai, once confirmed: the next run shows the steps whose values differ.
  routineSetup: routineSetupConfirmed ? guideValues().fingerprints : state.routineSetup,
  idp: { name: idpName, database: idpDatabase, databaseId: idpDatabaseId, origin: idpOrigin, customOrigin: customIdpOrigin },
  planner: { name: plannerName, database: plannerDatabase, databaseId: plannerDatabaseId, origin: plannerOrigin, customOrigin: customPlannerOrigin },
  deployedAt: new Date().toISOString(),
});

// ---------------------------------------------------------------------------
// 9. A first user

if (!options['skip-user']) {
  const countResult = wrangler(
    IDP_DIR,
    ['d1', 'execute', 'DB', '--remote', '--json', '--command', 'SELECT COUNT(*) AS count FROM users', ...deployArgs(IDP_DIR)],
    { input: '' },
  );
  const count = Number(JSON.parse(countResult.stdout)[0]?.results?.[0]?.count ?? 0);
  if (count === 0) {
    const fromEnv = process.env.ADMIN_USER_ID && process.env.ADMIN_USER_PASSWORD;
    if (fromEnv || (interactive && (await confirm('IdP にユーザーがいません。最初のユーザーを作成しますか？', true)))) {
      const id = process.env.ADMIN_USER_ID ?? (await ask('ユーザー ID（ログイン時に入力する値）'));
      const name = process.env.ADMIN_USER_NAME ?? (await ask('表示名', { defaultValue: id }));
      const email = process.env.ADMIN_USER_EMAIL ?? (await ask('メールアドレス（任意）', { defaultValue: '' }));
      const password = process.env.ADMIN_USER_PASSWORD ?? (await ask('パスワード（12 文字以上）', { secret: true }));
      const args = ['--filter', '@apps/idp', 'user', 'add', id, '--name', name, '--password-stdin', '--remote'];
      if (email) args.push('--email', email);
      run('pnpm', args, { input: `${password}\n` });
      ok(`ユーザー ${id} を作成しました`);
    } else {
      warn('ユーザーがいないため、まだ誰もログインできません。`pnpm --filter @apps/idp user add <id> --remote` で作成してください。');
    }
  } else {
    ok(`IdP のユーザー: ${count} 人`);
  }
}
closePrompts();

// ---------------------------------------------------------------------------
// 10. Check

log('公開された URL を確認します（初回は workers.dev の反映に 1〜2 分かかることがあります）');
await waitForJson(`${idpOrigin}/.well-known/openid-configuration`, (body) => body.issuer === idpOrigin);
ok(`IdP の Discovery が issuer ${idpOrigin} を返しました`);
await waitForJson(`${plannerOrigin}/health`, (body) => body.status === 'ok');
ok('planner が応答しました');

console.log(`
デプロイが完了しました。

  planner  ${plannerOrigin}
  IdP      ${idpOrigin}

ルーチンの設定を確かめるには、ルーチンの詳細ページ（https://claude.ai/code/routines）で「Run now」をテキストなしで実行します。
ルーチンは ${plannerOrigin}/api/routine/ping を呼んで結果を報告します。セッションに HTTP 200 が出れば完了です。
HTTP 401 なら network secret（Secret type、Allowed websites、Custom headers の Value）を、接続できなければ環境の Allowed domains を見直してください。

ルーチンの環境（許可ドメイン、network secret）とプロンプトは、${plannerOrigin}/setup でも確認できます。
ルーチンの URL とトークン、Bearer トークンを変えるときも \`pnpm run deploy\` を実行し、変える値だけを入力します（空のまま Enter で登録済みの値を使う）。
`);
