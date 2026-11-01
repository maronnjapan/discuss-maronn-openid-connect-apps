/**
 * The statements of schema.sql, for databases that are set up at startup
 * (for example node:sqlite: database.exec(SCHEMA_SQL)). Every statement is
 * CREATE ... IF NOT EXISTS, so running it again is harmless.
 */
export const SCHEMA_SQL = `-- Tables of the generated OpenID Provider (stores.ts, clients.ts and users.ts of db/).
--
-- The tables follow the ER model of the OP: clients, users, authorization
-- transactions, codes and tokens. Each comment names the entity a table
-- stores, and what the OP needs beyond that model is marked "Not in the ER
-- model".
--
-- The same statements run on SQLite, Cloudflare D1 and PostgreSQL. Dates are
-- epoch seconds in BIGINT columns, because the three share no date type that
-- every driver binds and reads the same way. Booleans are BOOLEAN, and JSON is
-- TEXT. Codes and tokens are stored as their SHA-256 hash, client secrets as
-- the hash from hashClientSecret() and passwords as the hash from
-- hashPassword(), so the database holds no credential that works as it is.
--
-- Foreign keys tie together the rows of one client, of one user and of one
-- authorization transaction. Transactions and tokens do not reference clients
-- or users with a foreign key, so the OP still works when clients or users come
-- from elsewhere (options.clientResolver, your own userStore). SQLite checks
-- foreign keys only with PRAGMA foreign_keys = ON, which node:sqlite and D1
-- turn on by default.
--
-- Expired rows are not deleted by the OP. Delete them on a schedule if needed,
-- e.g. DELETE FROM transactions WHERE expired_at <= <now in epoch seconds>.

-- Client: a registered client, id being its client_id. The OP does not know a
-- deleted client (is_deleted).
CREATE TABLE IF NOT EXISTS clients (
  id          TEXT PRIMARY KEY,
  name        VARCHAR(1000),
  client_type VARCHAR(1000) NOT NULL CHECK (client_type IN ('public', 'confidential')),
  is_deleted  BOOLEAN NOT NULL DEFAULT FALSE
);

-- Client_auth: a method the client may authenticate with at the token
-- endpoint. A public client has none. A confidential client has one row per
-- method it may use: client_secret_basic, client_secret_post or both. Every
-- row of a client carries the same secret in client_secrets, because a client
-- has one client_secret (RFC 7591 §2). Another method (such as
-- private_key_jwt) is added here when the OP supports it.
CREATE TABLE IF NOT EXISTS client_auths (
  id               TEXT PRIMARY KEY,
  client_id        TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  client_auth_type VARCHAR(1000) NOT NULL
    CHECK (client_auth_type IN ('client_secret_basic', 'client_secret_post')),
  UNIQUE (id, client_auth_type)
);
CREATE INDEX IF NOT EXISTS client_auths_client_id_idx ON client_auths (client_id);

-- Client_secret: the secret of a client_secret_basic / client_secret_post
-- row. client_auth_type is part of the foreign key, so it always equals the
-- type of its client_auths row. secret is the hash from hashClientSecret().
CREATE TABLE IF NOT EXISTS client_secrets (
  id               TEXT PRIMARY KEY,
  client_auth_type VARCHAR(1000) NOT NULL
    CHECK (client_auth_type IN ('client_secret_basic', 'client_secret_post')),
  secret           VARCHAR(5000) NOT NULL,
  FOREIGN KEY (id, client_auth_type)
    REFERENCES client_auths (id, client_auth_type) ON DELETE CASCADE
);

-- Client_jwk: a public key of the client for one purpose, one JWK (RFC 7517)
-- as JSON. purpose names the process that uses the key: request_object for
-- the signed Request Objects the OP verifies (OIDC Core 1.0 §6.3.2), or
-- another one such as private_key_jwt (OIDC Core 1.0 §9) or dpop (RFC 9449)
-- for a process a project adds. It has no CHECK, so a new purpose needs no
-- migration. A key used for two purposes is two rows. The OP reads the keys
-- of a purpose each time a process needs them, so a key inserted or deleted
-- here takes effect at once. Never store a private key.
CREATE TABLE IF NOT EXISTS client_jwks (
  id        TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  purpose   VARCHAR(1000) NOT NULL,
  jwk       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS client_jwks_client_id_purpose_idx ON client_jwks (client_id, purpose);

-- Redirect_Uri: the redirect URIs of the client.
CREATE TABLE IF NOT EXISTS client_redirect_uris (
  id        TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  value     VARCHAR(5000) NOT NULL
);
CREATE INDEX IF NOT EXISTS client_redirect_uris_client_id_idx ON client_redirect_uris (client_id);

-- Grant: the grant types the client may use. A client without rows may use
-- authorization_code only.
CREATE TABLE IF NOT EXISTS client_grant_types (
  id         TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  grant_type VARCHAR(1000) NOT NULL
);
CREATE INDEX IF NOT EXISTS client_grant_types_client_id_idx ON client_grant_types (client_id);

-- Not in the ER model: the response types the client may use at the
-- authorization endpoint (OpenID Connect Dynamic Client Registration 1.0):
-- code, or id_token and id_token token for the Implicit Flow. A client
-- without rows may use code only.
CREATE TABLE IF NOT EXISTS client_response_types (
  id            TEXT PRIMARY KEY,
  client_id     TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  response_type VARCHAR(1000) NOT NULL
);
CREATE INDEX IF NOT EXISTS client_response_types_client_id_idx ON client_response_types (client_id);

-- Scope: the scopes the client may request. A request for any other scope is
-- rejected with invalid_scope. A client without rows may request every scope
-- the OP accepts.
CREATE TABLE IF NOT EXISTS client_scopes (
  id        TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  value     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS client_scopes_client_id_idx ON client_scopes (client_id);

-- User: a user of the OP. email and is_verified are the email and
-- email_verified claims. password_hash is the hash from hashPassword()
-- (users.ts), and NULL for a user who has no password and signs in another
-- way (such as Sign in with Google).
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         VARCHAR(1000),
  is_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  password_hash VARCHAR(1000),
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  -- Not in the ER model: the other claims of the user (name, address, ...) as JSON.
  claims        TEXT
);

-- Federated_identity: the account of a user at an external IdP, for an upstream
-- sign-in such as Sign in with Google (--enable google-login). A user is found
-- by provider_sub, which the IdP never reassigns, and never by email.
CREATE TABLE IF NOT EXISTS federated_identities (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider     VARCHAR(1000) NOT NULL,
  provider_sub VARCHAR(255) NOT NULL,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,
  UNIQUE (provider, provider_sub)
);
CREATE INDEX IF NOT EXISTS federated_identities_user_id_idx ON federated_identities (user_id);

-- Transaction: one authorization request, from /authorize until its code is
-- exchanged. status moves requested -> upstream_pending -> authenticated ->
-- code_issued -> token_issued, or ends as failed without a code. The
-- Implicit Flow, whose authorization endpoint returns the tokens itself,
-- moves from authenticated to token_issued.
CREATE TABLE IF NOT EXISTS transactions (
  transaction_id VARCHAR(5000) PRIMARY KEY,
  status         VARCHAR(1000) NOT NULL CHECK (status IN
    ('requested', 'upstream_pending', 'authenticated', 'code_issued', 'token_issued', 'failed')),
  created_at     BIGINT NOT NULL,
  expired_at     BIGINT NOT NULL,
  -- Not in the ER model: the CSRF token, the count of failed logins and the
  -- hash that binds the transaction to its browser, as JSON.
  payload        TEXT NOT NULL
);

-- Authentication_request: the validated parameters of the authorization request.
CREATE TABLE IF NOT EXISTS authentication_requests (
  transaction_id        VARCHAR(5000) PRIMARY KEY
    REFERENCES transactions (transaction_id) ON DELETE CASCADE,
  client_id             VARCHAR(5000) NOT NULL,
  redirect_uri          TEXT NOT NULL,
  state                 VARCHAR(5000),
  nonce                 VARCHAR(5000),
  code_challenge        VARCHAR(5000),
  code_challenge_method VARCHAR(5000),
  response_type         VARCHAR(5000) NOT NULL,
  scope                 TEXT,
  -- Not in the ER model: the other parameters of OpenID Connect Core 1.0
  -- (§3.1.2.1, claims_locales §5.2, claims §5.5), each NULL when the request
  -- did not send it. response_mode is the response mode the OP answers in:
  -- form_post, fragment (the Implicit Flow, and response_mode=fragment), or
  -- query.jwt for JARM's query.jwt and jwt. It is NULL for the query response,
  -- response_mode=query included. prompt is space-delimited, max_age is in
  -- seconds and claims is the claims request as JSON.
  response_mode         VARCHAR(5000),
  prompt                VARCHAR(5000),
  max_age               BIGINT,
  ui_locales            VARCHAR(5000),
  claims_locales        VARCHAR(5000),
  id_token_hint         TEXT,
  login_hint            VARCHAR(5000),
  acr_values            VARCHAR(5000),
  claims                TEXT,
  -- Always NULL: the OP verifies a Request Object and keeps its parameters in
  -- the other columns, not the object itself.
  request_object        TEXT,
  -- Not in the ER model: the rest of the request (whether redirect_uri was
  -- sent, the audience, and the values a feature adds) as JSON.
  payload               TEXT NOT NULL
);

-- Upstream_auth_request: the sign-in at an external IdP a transaction waits
-- for. nonce is the value the login page sends to the IdP, which returns it in
-- its ID Token. Sign in with Google (redirect mode) sends no state and uses no
-- PKCE, so state and code_verifier stay NULL. Only the latest login page of a
-- transaction has a working upstream sign-in.
CREATE TABLE IF NOT EXISTS upstream_auth_requests (
  transaction_id VARCHAR(5000) PRIMARY KEY
    REFERENCES transactions (transaction_id) ON DELETE CASCADE,
  provider       VARCHAR(1000) NOT NULL,
  state          VARCHAR(5000) UNIQUE,
  nonce          VARCHAR(5000) NOT NULL UNIQUE,
  code_verifier  VARCHAR(5000)
);

-- Auth_user: who signed in for the transaction, handed from the login step to
-- the consent step. auth_type is password (the login form of the OP) or the
-- provider of a federated sign-in, such as google.
CREATE TABLE IF NOT EXISTS auth_users (
  transaction_id VARCHAR(5000) PRIMARY KEY
    REFERENCES transactions (transaction_id) ON DELETE CASCADE,
  user_id        VARCHAR(5000) NOT NULL,
  auth_type      VARCHAR(5000) NOT NULL,
  -- Not in the ER model: when the user signed in, and the browser session it started.
  auth_time      BIGINT NOT NULL,
  session_id     TEXT
);

-- Code: an authorization code. id is the SHA-256 hash of the code.
CREATE TABLE IF NOT EXISTS codes (
  id             TEXT PRIMARY KEY,
  transaction_id VARCHAR(5000) REFERENCES transactions (transaction_id) ON DELETE SET NULL,
  expired_at     BIGINT NOT NULL,
  is_used        BOOLEAN NOT NULL DEFAULT FALSE,
  -- Not in the ER model: the grant the tokens of the code belong to, and the
  -- rest of the code (client, redirect_uri, scope, user, PKCE, ...) as JSON.
  grant_id       TEXT NOT NULL,
  payload        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS codes_grant_id_idx ON codes (grant_id);

-- Access_token: an issued access token. id is its jti. The token itself is not
-- stored: it is looked up by token_hash, its SHA-256 hash.
CREATE TABLE IF NOT EXISTS access_tokens (
  id                    TEXT PRIMARY KEY,
  sub                   VARCHAR(5000) NOT NULL,
  exp                   BIGINT NOT NULL,
  iat                   BIGINT,
  iss                   VARCHAR(5000),
  client_id             VARCHAR(5000) NOT NULL,
  scope                 TEXT,
  -- The acr claim of the token (RFC 9068, OpenID Connect Core 1.0): the
  -- authentication context class the token was issued for, the same as the acr
  -- of its ID Token. NULL when the token has none, as when the authorization
  -- request asked for no acr (acr_values).
  acr                   VARCHAR(5000),
  -- Always NULL: the OP does not issue authorization_details (RFC 9396) yet.
  authorization_details TEXT,
  transaction_id        VARCHAR(5000) REFERENCES transactions (transaction_id) ON DELETE SET NULL,
  -- Not in the ER model: the lookup hash, the grant, and the rest of the token
  -- (nbf, audience, claims) as JSON.
  token_hash            TEXT NOT NULL UNIQUE,
  grant_id              TEXT,
  payload               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS access_tokens_grant_id_idx ON access_tokens (grant_id);

-- Refresh_token: an issued refresh token. id is the SHA-256 hash of the token,
-- and access_token_id the access token of the same token response.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id              TEXT PRIMARY KEY,
  access_token_id TEXT REFERENCES access_tokens (id) ON DELETE SET NULL,
  exp             BIGINT NOT NULL,
  iat             BIGINT,
  is_used         BOOLEAN NOT NULL DEFAULT FALSE,
  -- Not in the ER model: the grant, and the rest of the token (user, scope,
  -- auth_time, the session it is bound to, ...) as JSON.
  grant_id        TEXT NOT NULL,
  payload         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS refresh_tokens_grant_id_idx ON refresh_tokens (grant_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_access_token_id_idx ON refresh_tokens (access_token_id);

-- Not in the ER model: OP browser sessions (the session_id cookie) for SSO,
-- prompt=none and max_age.
CREATE TABLE IF NOT EXISTS browser_sessions (
  session_id TEXT PRIMARY KEY,
  subject    TEXT NOT NULL,
  auth_time  BIGINT NOT NULL
);

-- Not in the ER model: the scopes a user granted to a client, one row per scope.
CREATE TABLE IF NOT EXISTS consent_scopes (
  subject   TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope     TEXT NOT NULL,
  PRIMARY KEY (subject, client_id, scope)
);

-- Not in the ER model: the grants issued under a consent, so revoking the
-- consent revokes their tokens.
CREATE TABLE IF NOT EXISTS consent_grants (
  subject   TEXT NOT NULL,
  client_id TEXT NOT NULL,
  grant_id  TEXT NOT NULL,
  PRIMARY KEY (subject, client_id, grant_id)
);
`;
