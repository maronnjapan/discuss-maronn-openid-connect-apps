/**
 * Registered clients on the client tables of schema.sql: the ClientResolver
 * and the ClientKeyResolver the OP uses when no other ones are passed in, and
 * registerClient() to put a client into those tables.
 *
 * How the tables become a RegisteredClient (config.ts):
 *
 * - clients.client_type public: no client authentication
 *   (tokenEndpointAuthMethods ['none']).
 * - client_auths and client_secrets: the methods the client may authenticate
 *   with (tokenEndpointAuthMethods: client_secret_basic, client_secret_post or
 *   both), and the clientSecretHash the presented secret is checked against
 *   whichever of them the request uses. A client has one client_secret
 *   (RFC 7591 §2), so rows of one client with different secrets are a
 *   configuration error.
 * - client_redirect_uris, client_grant_types and client_scopes: redirectUris,
 *   grantTypes and scope. A request for a scope outside scope is rejected with
 *   invalid_scope (validateClientScope() in core). A client without
 *   client_scopes rows may request every scope the OP accepts.
 * - client_response_types: responseTypes, the response types the client may
 *   use at the authorization endpoint (id_token and id_token token for the
 *   Implicit Flow). A client without rows may use code only.
 * - Metadata without a column (default_max_age, the ID Token and UserInfo
 *   signing algs) keeps its default.
 *
 * The client's public keys (client_jwks) are not part of the RegisteredClient.
 * A process that needs them asks the ClientKeyResolver for the keys of its own
 * purpose (ClientKeyResolver in core): the OP verifies signed Request Objects
 * with those of request_object, and a process a project adds reads its own
 * purpose (private_key_jwt or dpop, for one).
 *
 * findClient() and findClientKeys() read the tables on every call, so a row
 * inserted or deleted while the OP runs takes effect from the next request.
 * That is how a client's keys are added or rotated without a restart:
 *
 *   INSERT INTO client_jwks (id, client_id, purpose, jwk)
 *     VALUES ('my-client:request_object:2026-10', 'my-client', 'request_object',
 *             '{"kty":"RSA","kid":"2026-10","n":"...","e":"AQAB"}');
 *
 * Store public keys only: a client_jwks row is one JWK (RFC 7517) without d or
 * any other private member.
 */
import {
  hashClientSecret,
  isPublicTokenClient,
  selectRegisteredClientAuthMethods,
  type ClientKeyPurpose,
  type ClientKeyResolver,
  type ClientResolver,
  type Jwk,
  type JwkSet,
  type TokenClientResolver,
} from '@maronn-openid-connect/core';
import type { ClientRegistration, RegisteredClient } from '../config.js';
import type { SqlDatabase } from './database.js';

export function createClientResolver(db: SqlDatabase): ClientResolver & TokenClientResolver {
  return {
    async findClient(clientId: string): Promise<RegisteredClient | null> {
      const [client] = await db.all<{ id: string; client_type: string }>({
        sql: 'SELECT id, client_type FROM clients WHERE id = ? AND is_deleted = FALSE',
        params: [clientId],
      });
      if (!client) return null;
      const auths = await db.all<{ client_auth_type: string; secret: string | null }>({
        sql:
          'SELECT a.client_auth_type, s.secret FROM client_auths a ' +
          'LEFT JOIN client_secrets s ON s.id = a.id WHERE a.client_id = ? ORDER BY a.id',
        params: [clientId],
      });
      const redirectUris = await db.all<{ value: string }>({
        sql: 'SELECT value FROM client_redirect_uris WHERE client_id = ? ORDER BY id',
        params: [clientId],
      });
      const grantTypes = await db.all<{ grant_type: string }>({
        sql: 'SELECT grant_type FROM client_grant_types WHERE client_id = ? ORDER BY id',
        params: [clientId],
      });
      const scopes = await db.all<{ value: string }>({
        sql: 'SELECT value FROM client_scopes WHERE client_id = ? ORDER BY id',
        params: [clientId],
      });
      const responseTypes = await db.all<{ response_type: string }>({
        sql: 'SELECT response_type FROM client_response_types WHERE client_id = ? ORDER BY id',
        params: [clientId],
      });

      const registered: RegisteredClient = {
        clientId: client.id,
        clientType: client.client_type === 'public' ? 'public' : 'confidential',
        redirectUris: redirectUris.map((row) => row.value),
      };
      if (grantTypes.length > 0) registered.grantTypes = grantTypes.map((row) => row.grant_type);
      if (scopes.length > 0) registered.scope = scopes.map((row) => row.value);
      if (responseTypes.length > 0) registered.responseTypes = responseTypes.map((row) => row.response_type);

      if (registered.clientType === 'public') {
        registered.tokenEndpointAuthMethods = ['none'];
      } else if (auths[0]) {
        // A client has one client_secret (RFC 7591 §2), whichever method
        // presents it.
        const secret = auths[0].secret;
        if (auths.some((auth) => auth.secret !== secret)) {
          throw new Error('Client ' + clientId + ' has client_auths rows with different secrets');
        }
        registered.tokenEndpointAuthMethods = auths.map((auth) => auth.client_auth_type as ClientAuthType);
        if (secret !== null) registered.clientSecretHash = secret;
      }
      // A confidential client without a client_auths row keeps the default
      // client_secret_basic with no secret, so it cannot authenticate.
      return registered;
    },
  };
}

type ClientAuthType = 'client_secret_basic' | 'client_secret_post';

/**
 * The public keys of client_jwks for one purpose at a time: the
 * ClientKeyResolver the OP uses when no other one is passed in. The OP
 * verifies a signed Request Object with the keys of request_object. A deleted
 * client (is_deleted) has no keys.
 */
export function createClientKeyResolver(db: SqlDatabase): ClientKeyResolver {
  return {
    async findClientKeys(clientId: string, purpose: ClientKeyPurpose): Promise<JwkSet> {
      const rows = await db.all<{ jwk: string }>({
        sql:
          'SELECT k.jwk FROM client_jwks k JOIN clients c ON c.id = k.client_id ' +
          'WHERE k.client_id = ? AND k.purpose = ? AND c.is_deleted = FALSE ORDER BY k.id',
        params: [clientId, purpose],
      });
      return { keys: rows.map((row) => parseJwk(clientId, row.jwk)) };
    },
  };
}

/** A client_jwks row holds one public JWK as a JSON object. */
function parseJwk(clientId: string, json: string): Jwk {
  let jwk: unknown;
  try {
    jwk = JSON.parse(json);
  } catch {
    jwk = undefined;
  }
  if (typeof jwk !== 'object' || jwk === null || Array.isArray(jwk)) {
    throw new Error('Client ' + clientId + ' has a client_jwks row that is not a JSON JWK');
  }
  return jwk as Jwk;
}

/**
 * Put a client into the client tables, replacing the rows of an earlier
 * registration with the same client_id. Call it from a setup script or at
 * startup, with the database of db/ (createDatabase() of db/index.ts) and a
 * ClientRegistration (config.ts):
 *
 *   // createDatabase(c) where the request context exists, when instance.ts
 *   // reads it (in the Hono output, a binding of c.env such as D1)
 *   const db = createDatabase();
 *   await registerClient(db, {
 *     clientId: 'my-client',
 *     clientSecret: '...',
 *     redirectUris: ['https://client.example.com/callback'],
 *     grantTypes: ['authorization_code', 'refresh_token'],
 *     tokenEndpointAuthMethods: ['client_secret_basic'],
 *   });
 *
 * Registering a client again with the same values leaves its rows as they
 * are, so every instance of the OP may register its clients at startup, even
 * at the same moment: each row's id comes from the values it holds, so two
 * registrations write the same rows instead of adding copies. When the values
 * change, the new redirect URIs, grant types, scopes and response types go in
 * before the old ones are removed, so requests in between still find the
 * client.
 *
 * clientSecret is saved as its hash (hashClientSecret()). The statements run
 * one at a time (SqlDatabase has no transactions), so run it again if it stops
 * halfway.
 *
 * Each method of tokenEndpointAuthMethods becomes a client_auths row, all of
 * them with the same secret.
 *
 * Each key of keys (ClientRegistration.keys) becomes a client_jwks row of its
 * purpose. The client_jwks rows are only ever added here: registerClient()
 * never deletes one, so they may be managed in the database while the OP runs
 * (see the top of this file), and registering the client again at the next
 * start keeps them. To remove a key, delete its row in the database, and drop
 * it from the client passed here too, or the next registration adds it back.
 */
export async function registerClient(
  db: SqlDatabase,
  client: ClientRegistration & { name?: string },
): Promise<void> {
  const clientType = client.clientType ?? (isPublicTokenClient(client) ? 'public' : 'confidential');
  await db.run({
    sql:
      'INSERT INTO clients (id, name, client_type, is_deleted) VALUES (?, ?, ?, FALSE) ' +
      'ON CONFLICT (id) DO UPDATE SET name = excluded.name, client_type = excluded.client_type, ' +
      'is_deleted = FALSE',
    params: [client.clientId, client.name ?? null, clientType],
  });

  const secretHash =
    client.clientSecretHash ??
    (client.clientSecret !== undefined ? await hashClientSecret(client.clientSecret) : undefined);
  const methods =
    clientType === 'confidential'
      ? selectRegisteredClientAuthMethods(client).filter(
        (method): method is ClientAuthType => method === 'client_secret_basic' || method === 'client_secret_post',
      )
      : [];
  const auths: Array<{ id: string; method: ClientAuthType; secretHash: string }> = [];
  if (secretHash !== undefined) {
    for (const method of methods) {
      auths.push({ id: await childRowId(client.clientId, 'client_auths', method), method, secretHash });
    }
  }
  const authIds = auths.map((auth) => auth.id);
  // The rows of a method the client no longer lists go first. Secrets go
  // before their client_auths rows: they reference them, and SQLite cascades
  // only with foreign keys on.
  await db.run({
    sql: exceptIds('DELETE FROM client_secrets WHERE id IN (SELECT id FROM client_auths WHERE client_id = ?)', authIds),
    params: [client.clientId, ...authIds],
  });
  await db.run({
    sql: exceptIds('DELETE FROM client_auths WHERE client_id = ?', authIds),
    params: [client.clientId, ...authIds],
  });
  for (const auth of auths) {
    await db.run({
      sql: 'INSERT INTO client_auths (id, client_id, client_auth_type) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING',
      params: [auth.id, client.clientId, auth.method],
    });
    await db.run({
      sql:
        'INSERT INTO client_secrets (id, client_auth_type, secret) VALUES (?, ?, ?) ' +
        'ON CONFLICT (id) DO UPDATE SET secret = excluded.secret',
      params: [auth.id, auth.method, auth.secretHash],
    });
  }
  for (const [purpose, keySet] of Object.entries(client.keys ?? {})) {
    for (const key of keySet?.keys ?? []) {
      const jwk = JSON.stringify(key);
      await db.run({
        sql:
          'INSERT INTO client_jwks (id, client_id, purpose, jwk) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT (id) DO NOTHING',
        params: [
          await childRowId(client.clientId, 'client_jwks', JSON.stringify([purpose, jwk])),
          client.clientId,
          purpose,
          jwk,
        ],
      });
    }
  }

  const childValues: Array<[table: string, column: string, values: readonly string[]]> = [
    ['client_redirect_uris', 'value', client.redirectUris],
    ['client_grant_types', 'grant_type', client.grantTypes ?? []],
    ['client_scopes', 'value', client.scope ?? []],
    ['client_response_types', 'response_type', client.responseTypes ?? []],
  ];
  for (const [table, column, values] of childValues) {
    const ids: string[] = [];
    for (const value of values) {
      const id = await childRowId(client.clientId, table, value);
      ids.push(id);
      await db.run({
        sql: 'INSERT INTO ' + table + ' (id, client_id, ' + column + ') VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING',
        params: [id, client.clientId, value],
      });
    }
    await db.run({
      sql: exceptIds('DELETE FROM ' + table + ' WHERE client_id = ?', ids),
      params: [client.clientId, ...ids],
    });
  }
}

/**
 * The id of a row under a client: the SHA-256 (hex) of the client_id, the
 * table and the value the row holds, so the same value always maps to the
 * same row.
 */
async function childRowId(clientId: string, table: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([clientId, table, value])),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A DELETE of a client's rows, narrowed to the rows whose id is not in keep. */
function exceptIds(sql: string, keep: readonly string[]): string {
  return keep.length === 0 ? sql : sql + ' AND id NOT IN (' + keep.map(() => '?').join(', ') + ')';
}
