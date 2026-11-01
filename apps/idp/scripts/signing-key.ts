/**
 * Generates an RS256 signing key for OIDC_SIGNING_KEYS.
 *
 *   pnpm --filter @apps/idp signing-key                 # a new key set (one key) on stdout
 *   pnpm --filter @apps/idp signing-key --rotate <file> # a new key first, then the keys of <file>
 *
 * Pipe the output to `wrangler secret put OIDC_SIGNING_KEYS`. When rotating,
 * keep the old key in the set until the tokens it signed have expired (one
 * hour for ID Tokens and access tokens of this IdP), then drop it.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { generateSigningJwk, parseSigningKeysJson } from '../src/signing-keys.js';

const { values } = parseArgs({ options: { rotate: { type: 'string' }, kid: { type: 'string' } } });

const kid = values.kid ?? `idp-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
const key = await generateSigningJwk(kid);
const previous = values.rotate ? parseSigningKeysJson(readFileSync(values.rotate, 'utf8')) : [];
process.stdout.write(JSON.stringify([key, ...previous]));
if (process.stdout.isTTY) process.stdout.write('\n');
