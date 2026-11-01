#!/usr/bin/env node
/**
 * Deletes what scripts/deploy.mjs created on Cloudflare:
 *
 *   1. the planner Worker (with its secrets)
 *   2. the IdP Worker (with its secrets)
 *   3. the planner's D1 database
 *   4. the IdP's D1 database (users, clients, tokens)
 *   5. the wrangler.deploy.jsonc files
 *
 *   pnpm run destroy             # asks you to type the planner's Worker name to confirm
 *   pnpm run destroy --yes       # without confirmation (CI)
 *   pnpm run destroy --dry-run   # show what would be deleted
 *   pnpm run destroy --local     # delete the local development state instead (.wrangler/state, .dev.vars)
 *
 * The data in D1 cannot be recovered. A failed step does not stop the
 * others, and running it again skips what is already gone. .deploy/state.json
 * keeps the names and the workers.dev subdomain for a later deploy.
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { IDP_DIR, PLANNER_DIR, ask, closePrompts, log, ok, warn, wrangler } from './lib.mjs';
import { loadState, saveState } from './state.mjs';

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
    local: { type: 'boolean', default: false },
  },
});

if (options.local) {
  for (const dir of [IDP_DIR, PLANNER_DIR]) {
    for (const target of ['.wrangler/state', '.dev.vars']) {
      const path = join(dir, target);
      if (!existsSync(path)) continue;
      if (options['dry-run']) {
        log(`削除予定: ${path}`);
      } else {
        rmSync(path, { recursive: true, force: true });
        ok(`削除しました: ${path}`);
      }
    }
  }
  console.log('\nもう一度使うときは `pnpm setup:local` を実行してください。');
  process.exit(0);
}

const state = loadState();
const idpName = state.idp?.name ?? 'maronn-idp';
const plannerName = state.planner?.name ?? 'maronn-planner';
const idpDatabase = state.idp?.database ?? idpName;
const plannerDatabase = state.planner?.database ?? plannerName;
if (!state.idp) warn('.deploy/state.json がないため、既定の名前（maronn-idp / maronn-planner）を対象にします。');

const accountArgs = state.accountId ? { env: { CLOUDFLARE_ACCOUNT_ID: state.accountId } } : {};

console.log(`
次のリソースを削除します。D1 のデータ（ユーザー、計画書）は元に戻せません。

  Worker  ${plannerName}（planner）
  Worker  ${idpName}（IdP）
  D1      ${plannerDatabase}
  D1      ${idpDatabase}
`);

if (!options['dry-run'] && !options.yes) {
  if (!process.stdin.isTTY) {
    console.error('確認できないため中止しました。非対話の環境では --yes を付けてください。');
    process.exit(1);
  }
  const answer = await ask(`確認のため planner の Worker 名（${plannerName}）を入力してください`);
  closePrompts();
  if (answer !== plannerName) {
    console.log('入力が一致しないため、中止しました。');
    process.exit(1);
  }
}

const results = [];

function step(label, fn) {
  if (options['dry-run']) {
    results.push(`- ${label}（dry-run のため未実行）`);
    return;
  }
  try {
    const outcome = fn();
    results.push(`✔ ${label}${outcome ? `（${outcome}）` : ''}`);
  } catch (error) {
    results.push(`✘ ${label}: ${error.message.split('\n').slice(0, 3).join(' ')}`);
  }
}

function workerExists(appDir, name) {
  const result = wrangler(appDir, ['deployments', 'list', '--name', name, '--json'], { ...accountArgs, allowFailure: true, input: '' });
  return result.status === 0;
}

function deleteWorker(appDir, name) {
  if (!workerExists(appDir, name)) return '存在しないためスキップ';
  // Non-interactive input makes wrangler answer its own confirmation with yes.
  wrangler(appDir, ['delete', name, '--force'], { ...accountArgs, input: '' });
  return undefined;
}

function databaseExists(name) {
  const list = JSON.parse(wrangler(IDP_DIR, ['d1', 'list', '--json'], { ...accountArgs, input: '' }).stdout);
  return list.some((db) => db.name === name);
}

function deleteDatabase(name) {
  if (!databaseExists(name)) return '存在しないためスキップ';
  wrangler(IDP_DIR, ['d1', 'delete', name, '--skip-confirmation'], { ...accountArgs, input: '' });
  return undefined;
}

// The planner has a service binding to the IdP, so it goes first.
log('削除しています');
step(`Worker ${plannerName} を削除`, () => deleteWorker(PLANNER_DIR, plannerName));
step(`Worker ${idpName} を削除`, () => deleteWorker(IDP_DIR, idpName));
step(`D1 ${plannerDatabase} を削除`, () => deleteDatabase(plannerDatabase));
step(`D1 ${idpDatabase} を削除`, () => deleteDatabase(idpDatabase));
step('wrangler.deploy.jsonc を削除', () => {
  for (const dir of [IDP_DIR, PLANNER_DIR]) rmSync(join(dir, 'wrangler.deploy.jsonc'), { force: true });
  return undefined;
});

if (!options['dry-run'] && state.idp) {
  // Keep the names and the subdomain for a later deploy; the database ids are gone.
  delete state.idp.databaseId;
  delete state.planner?.databaseId;
  delete state.clientFingerprint;
  state.destroyedAt = new Date().toISOString();
  saveState(state);
}

console.log(`\n${results.join('\n')}\n`);
if (results.some((line) => line.startsWith('✘'))) {
  warn('失敗した手順があります。原因を確認してから、もう一度 `pnpm run destroy` を実行してください。');
  process.exit(1);
}
