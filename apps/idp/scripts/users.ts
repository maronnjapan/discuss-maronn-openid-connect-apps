/**
 * Manages the users who can sign in to the IdP.
 *
 *   pnpm --filter @apps/idp user add <id> --name "山田 太郎" --email taro@example.com [--remote]
 *   pnpm --filter @apps/idp user list [--remote]
 *   pnpm --filter @apps/idp user remove <id> [--remote]
 *
 * <id> is what the user types as ユーザー ID on the login screen, and the sub
 * of their ID Token. `add` asks for the password (or reads one line from
 * stdin with --password-stdin) and stores its PBKDF2 hash through
 * registerUser() of the generated db/users.ts. Running `add` again for an
 * existing id replaces the user, which is how a password is reset.
 *
 * Without --remote the local database of `wrangler dev` (.wrangler/state) is
 * used; with it, the D1 database on Cloudflare.
 */
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerUser } from '../src/oidc-provider/db/users.js';
import { splitSchemaStatements } from '../src/oidc-provider/db/instance.js';
import {
  APP_DIR,
  createRecordingDatabase,
  executeSqlFile,
  inlineStatement,
  queryRows,
  toSqlLiteral,
  type D1Target,
} from './d1.js';

const USER_ID_PATTERN = /^[A-Za-z0-9._@-]{3,64}$/;
const MIN_PASSWORD_LENGTH = 12;

function usage(): never {
  throw new Error(`使い方:
  user add <id> [--name <表示名>] [--email <メール>] [--password-stdin] [--remote]
  user list [--remote]
  user remove <id> [--remote]`);
}

function schemaSql(): string {
  const schema = readFileSync(join(APP_DIR, 'src/oidc-provider/db/schema.sql'), 'utf8');
  return splitSchemaStatements(schema).map((sql) => `${sql};`).join('\n');
}

async function readPassword(fromStdin: boolean): Promise<string> {
  if (fromStdin || !process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) {
      rl.close();
      return line;
    }
    throw new Error('stdin からパスワードを読めませんでした。');
  }
  const first = await askHidden('パスワード: ');
  const second = await askHidden('パスワード（確認）: ');
  if (first !== second) throw new Error('確認用のパスワードが一致しません。');
  return first;
}

/**
 * Reads one line from the terminal without showing it: the terminal is in
 * raw mode and the characters are collected here, so nothing is echoed.
 * Backspace and Ctrl+U edit, Ctrl+C aborts.
 */
function askHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolvePassword) => {
    let value = '';
    const finish = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk: string) => {
      // Drop escape sequences such as arrow keys and bracketed-paste markers.
      for (const char of chunk.replace(/\x1b\[[0-9;]*[~A-Za-z]/g, '')) {
        if (char === '\r' || char === '\n') {
          finish();
          resolvePassword(value);
          return;
        }
        if (char === '\u0003') {
          finish();
          process.exit(130);
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char === '\u0015') value = '';
        else if (char >= ' ') value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function addUser(id: string, options: { name?: string; email?: string; passwordStdin: boolean }, target: D1Target) {
  if (!USER_ID_PATTERN.test(id)) {
    throw new Error('ユーザー ID は 3〜64 文字の英数字と . _ @ - で指定してください。');
  }
  const password = await readPassword(options.passwordStdin);
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`パスワードは ${MIN_PASSWORD_LENGTH} 文字以上にしてください。`);
  }
  const { db, statements } = createRecordingDatabase();
  await registerUser(db, {
    sub: id,
    preferred_username: id,
    ...(options.name ? { name: options.name } : {}),
    ...(options.email ? { email: options.email, email_verified: true } : {}),
    updated_at: Math.floor(Date.now() / 1000),
    password,
  });
  executeSqlFile(target, [schemaSql(), ...statements.map((s) => `${inlineStatement(s)};`)].join('\n'));
  console.log(`ユーザー ${id} を登録しました（${target.remote ? 'Cloudflare の D1' : 'ローカルの D1'}）。`);
}

function listUsers(target: D1Target) {
  executeSqlFile(target, schemaSql());
  const rows = queryRows<{ id: string; email: string | null; claims: string; has_password: number; updated_at: number }>(
    target,
    'SELECT id, email, claims, password_hash IS NOT NULL AS has_password, updated_at FROM users ORDER BY id',
  );
  if (rows.length === 0) {
    console.log('ユーザーは登録されていません。');
    return;
  }
  console.table(
    rows.map((row) => ({
      id: row.id,
      name: (JSON.parse(row.claims || '{}') as { name?: string }).name ?? '',
      email: row.email ?? '',
      password: row.has_password ? 'あり' : 'なし',
      updated_at: new Date(Number(row.updated_at) * 1000).toISOString(),
    })),
  );
}

function removeUser(id: string, target: D1Target) {
  executeSqlFile(target, [schemaSql(), `DELETE FROM users WHERE id = ${toSqlLiteral(id)};`].join('\n'));
  console.log(`ユーザー ${id} を削除しました。`);
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      email: { type: 'string' },
      'password-stdin': { type: 'boolean', default: false },
      remote: { type: 'boolean', default: false },
    },
  });
  const [command, id] = positionals;
  const target: D1Target = { remote: values.remote ?? false };
  switch (command) {
    case 'add':
      if (!id) usage();
      await addUser(id, { name: values.name, email: values.email, passwordStdin: values['password-stdin'] ?? false }, target);
      break;
    case 'list':
      listUsers(target);
      break;
    case 'remove':
      if (!id) usage();
      removeUser(id, target);
      break;
    default:
      usage();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
