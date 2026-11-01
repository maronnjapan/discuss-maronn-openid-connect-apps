#!/usr/bin/env node
/**
 * Starts the IdP, the planner and the mock routine, with each line of output
 * prefixed by the app it came from. Ctrl+C stops all of them.
 *
 *   pnpm dev                 # with the mock routine
 *   pnpm dev --no-mock       # when apps/planner/.dev.vars points to a real routine
 *
 * The apps start one after another: two `wrangler dev` processes that start
 * at the same moment can collide on wrangler's internal sockets.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { IDP_DIR, LOCAL, PLANNER_DIR, ROOT } from './lib.mjs';

if (!existsSync(join(IDP_DIR, '.dev.vars')) || !existsSync(join(PLANNER_DIR, '.dev.vars'))) {
  console.error('.dev.vars がありません。先に `pnpm setup:local` を実行してください。');
  process.exit(1);
}

const processes = [
  { name: 'idp', color: 35, command: 'pnpm', args: ['--filter', '@apps/idp', 'exec', 'wrangler', 'dev'], ready: `${LOCAL.idpOrigin}/health` },
  { name: 'planner', color: 36, command: 'pnpm', args: ['--filter', '@apps/planner', 'exec', 'wrangler', 'dev'], ready: `${LOCAL.plannerOrigin}/health` },
];
if (!process.argv.includes('--no-mock')) {
  processes.push({
    name: 'routine',
    color: 33,
    command: 'node',
    args: [join(PLANNER_DIR, 'scripts/mock-routine.mjs')],
    ready: `${LOCAL.mockRoutineOrigin}/health`,
  });
}

const children = [];
let stopping = false;

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGINT');
  setTimeout(() => process.exit(code), 800);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function start({ name, color, command, args }) {
  const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '1' } });
  const prefix = `\x1b[${color}m${name.padEnd(7)}\x1b[0m │ `;
  const relay = (stream) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) process.stdout.write(prefix + line + '\n');
    });
  };
  relay(child.stdout);
  relay(child.stderr);
  child.on('exit', (code) => {
    process.stdout.write(`${prefix}exited (${code})\n`);
    shutdown(code ?? 0);
  });
  children.push(child);
}

async function waitFor(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stopping) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${url} が ${timeoutMs / 1000} 秒以内に起動しませんでした。`);
}

try {
  for (const entry of processes) {
    start(entry);
    await waitFor(entry.ready);
  }
  console.log(`
  IdP      ${LOCAL.idpOrigin}
  planner  ${LOCAL.plannerOrigin}   ← ブラウザで開く（testuser / password）
`);
} catch (error) {
  console.error(error.message);
  shutdown(1);
}
