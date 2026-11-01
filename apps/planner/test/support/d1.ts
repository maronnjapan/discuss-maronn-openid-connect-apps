/**
 * A stand-in for D1 on node:sqlite, for tests that go through the SQL of
 * src/db.ts: prepare / bind / first / all / run, and batch as one
 * transaction. Like D1, it refuses a statement whose bound parameters do not
 * match its placeholders, and binding undefined.
 *
 * node:sqlite runs each statement synchronously, so concurrent requests
 * interleave only at their awaits, the way D1 serializes the statements of a
 * database: a check made in one statement and acted on in another can race,
 * one conditional statement cannot.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = join(import.meta.dirname, '..', '..', 'migrations');

export const migrationFiles = () => readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort();

function placeholders(sql: string): number {
  let count = 0;
  let quoted = false;
  for (const char of sql) {
    if (char === "'") quoted = !quoted;
    else if (char === '?' && !quoted) count++;
  }
  return count;
}

type Result = { results: Record<string, unknown>[]; meta: { changes: number }; success: true };

export function createD1(options: { migrations?: string[] } = {}): { db: D1Database; raw: DatabaseSync; applyMigration: (name: string) => void } {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  const applyMigration = (name: string) => raw.exec(readFileSync(join(MIGRATIONS, name), 'utf8'));
  for (const name of options.migrations ?? migrationFiles()) applyMigration(name);

  class Statement {
    constructor(
      readonly sql: string,
      readonly params: unknown[] = [],
    ) {}
    bind(...params: unknown[]) {
      return new Statement(this.sql, params);
    }
    execute(): Result {
      const expected = placeholders(this.sql);
      if (expected !== this.params.length) throw new Error(`D1_ERROR: ${expected} placeholders, ${this.params.length} parameters: ${this.sql}`);
      if (this.params.some((param) => param === undefined)) throw new Error(`D1_TYPE_ERROR: undefined bound: ${this.sql}`);
      const statement = raw.prepare(this.sql);
      const params = this.params as (string | number | null)[];
      if (/^\s*SELECT/i.test(this.sql) || /\bRETURNING\b/i.test(this.sql)) {
        const results = statement.all(...params).map((row) => ({ ...row }));
        return { results, meta: { changes: /^\s*SELECT/i.test(this.sql) ? 0 : results.length }, success: true };
      }
      return { results: [], meta: { changes: Number(statement.run(...params).changes) }, success: true };
    }
    async first<T>() {
      return (this.execute().results[0] ?? null) as T | null;
    }
    async all() {
      return this.execute();
    }
    async run() {
      return this.execute();
    }
  }

  const db = {
    prepare: (sql: string) => new Statement(sql),
    async batch(statements: Statement[]) {
      raw.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement.execute());
        raw.exec('COMMIT');
        return results;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { db: db as unknown as D1Database, raw, applyMigration };
}
