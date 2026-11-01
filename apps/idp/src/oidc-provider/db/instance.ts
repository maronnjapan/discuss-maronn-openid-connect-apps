/**
 * The database instance: the one file in db/ that the CLI leaves to the
 * project (it is created once and never overwritten, not even with --force).
 *
 * The IdP keeps its data in Cloudflare D1 through the DB binding of
 * wrangler.jsonc. Wrangler emulates D1 locally in .wrangler/state, so local
 * development needs no database server.
 *
 * The tables of schema.sql are created by the first query of each isolate.
 * Every statement there is CREATE ... IF NOT EXISTS, so running them again on
 * an existing database changes nothing. scripts/users.ts applies the same
 * file before it writes a user, so a user can be added before the first
 * request reaches a fresh database.
 */
import type { Context } from 'hono';
import type { SqlDatabase, SqlStatement } from './database.js';
import { SCHEMA_SQL } from './schema.js';

export function createDatabase(c: Context): SqlDatabase {
  return d1Database(c.env.DB as D1Database);
}

/**
 * A SqlDatabase on a D1 binding. src/index.ts also uses it with the binding of
 * `env` (cloudflare:workers) for what it sets up outside the generated app.
 */
export function d1Database(d1: D1Database): SqlDatabase {
  return {
    async all<Row>(statement: SqlStatement): Promise<Row[]> {
      await applySchema(d1);
      const result = await d1.prepare(statement.sql).bind(...statement.params).all<Row>();
      return result.results;
    },
    async run(statement: SqlStatement) {
      await applySchema(d1);
      const result = await d1.prepare(statement.sql).bind(...statement.params).run();
      return { changes: result.meta.changes };
    },
  };
}

let schemaApplied: Promise<void> | undefined;

/**
 * Runs the statements of schema.sql as one batch. D1's exec() takes one
 * statement per line, which the multi-line CREATE TABLE statements are not,
 * so the comments are dropped and the rest is split at each semicolon.
 */
function applySchema(d1: D1Database): Promise<void> {
  schemaApplied ??= d1
    .batch(splitSchemaStatements(SCHEMA_SQL).map((sql) => d1.prepare(sql)))
    .then(() => undefined)
    .catch((error: unknown) => {
      // Let the next query try again instead of failing every request of the isolate.
      schemaApplied = undefined;
      throw error;
    });
  return schemaApplied;
}

export function splitSchemaStatements(schemaSql: string): string[] {
  return schemaSql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((sql) => sql.trim())
    .filter((sql) => sql.length > 0);
}
