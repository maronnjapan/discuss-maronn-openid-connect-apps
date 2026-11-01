/**
 * The database of the provider (--db sql): SQL tables (schema.sql) on any
 * driver or ORM, through the two methods of SqlDatabase (database.ts).
 *
 * app.ts reads the provider's data through these functions, and so does the
 * code that sets the provider up (registering clients and users). You write
 * one file, db/instance.ts: createDatabase() returns your database.
 */
import type { SqlDatabase } from './database.js';
import { createDatabase as createInstanceDatabase } from './instance.js';

export type { SqlDatabase as Database } from './database.js';

/**
 * The database of a request: createDatabase() of db/instance.ts, called with
 * the request context. An instance.ts whose createDatabase() takes no
 * argument (one database for the process) fits too.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const createDatabase: (c?: any) => SqlDatabase = createInstanceDatabase;
export { createProviderStores } from './stores.js';
export { createClientKeyResolver, createClientResolver, registerClient } from './clients.js';
export { registerUser } from './users.js';
