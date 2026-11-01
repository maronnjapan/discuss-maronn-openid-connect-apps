/**
 * Runs SQL on the IdP's D1 database through wrangler, locally
 * (.wrangler/state, the same state `wrangler dev` uses) or on Cloudflare.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SqlDatabase, SqlStatement, SqlValue } from '../src/oidc-provider/db/database.js';

export const APP_DIR = resolve(import.meta.dirname, '..');
export const DATABASE_BINDING = 'DB';

export interface D1Target {
  remote: boolean;
}

/** wrangler.deploy.jsonc (written by the deploy script) holds the real database_id. */
function configArgs(target: D1Target): string[] {
  const deployConfig = join(APP_DIR, 'wrangler.deploy.jsonc');
  if (target.remote && existsSync(deployConfig)) return ['--config', deployConfig];
  return [];
}

function wrangler(args: string[]): string {
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...args], {
    cwd: APP_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`wrangler ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/** Runs a SQL file (several statements) on the database. */
export function executeSqlFile(target: D1Target, sql: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'idp-d1-'));
  const file = join(dir, 'statements.sql');
  try {
    writeFileSync(file, sql);
    wrangler([
      'd1',
      'execute',
      DATABASE_BINDING,
      target.remote ? '--remote' : '--local',
      '--yes',
      '--file',
      file,
      ...configArgs(target),
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs one query and returns its rows. */
export function queryRows<Row>(target: D1Target, sql: string): Row[] {
  const stdout = wrangler([
    'd1',
    'execute',
    DATABASE_BINDING,
    target.remote ? '--remote' : '--local',
    '--json',
    '--command',
    sql,
    ...configArgs(target),
  ]);
  const parsed = JSON.parse(stdout) as { results: Row[] }[];
  return parsed.flatMap((result) => result.results);
}

/** A SQL literal for a bound value. Strings are quoted with '' escaping. */
export function toSqlLiteral(value: SqlValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Cannot write ${value} as SQL`);
    return String(value);
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/** Replaces each ? placeholder with its value. The generated SQL never has a ? inside a literal. */
export function inlineStatement(statement: SqlStatement): string {
  let index = 0;
  const sql = statement.sql.replace(/\?/g, () => {
    if (index >= statement.params.length) throw new Error(`Too few params for: ${statement.sql}`);
    return toSqlLiteral(statement.params[index++]!);
  });
  if (index !== statement.params.length) throw new Error(`Too many params for: ${statement.sql}`);
  return sql;
}

/**
 * A SqlDatabase that records the statements it is given instead of running
 * them, so functions of the generated db/ (registerUser()) can produce the SQL
 * that executeSqlFile() then runs in one go.
 */
export function createRecordingDatabase(): { db: SqlDatabase; statements: SqlStatement[] } {
  const statements: SqlStatement[] = [];
  return {
    statements,
    db: {
      async all() {
        throw new Error('The recording database cannot answer queries.');
      },
      async run(statement) {
        statements.push(statement);
        return { changes: 1 };
      },
    },
  };
}
