-- 実装計画書アプリのテーブル。時刻はすべて epoch 秒。

-- ログイン中のセッション。Cookie には乱数を、ここにはその SHA-256 を持つ。
CREATE TABLE sessions (
  id_hash    TEXT PRIMARY KEY,
  sub        TEXT NOT NULL,
  name       TEXT,
  email      TEXT,
  -- RP-Initiated Logout の id_token_hint に使う。
  id_token   TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expires_at ON sessions (expires_at);

-- 認可リクエストを送ってからコールバックを受けるまでの state / nonce / PKCE。
CREATE TABLE login_attempts (
  state         TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  nonce         TEXT NOT NULL,
  return_to     TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);

-- 1 つの機能についての計画づくり（依頼から計画書の確定まで）。
CREATE TABLE threads (
  id         TEXT PRIMARY KEY,
  owner_sub  TEXT NOT NULL,
  owner_name TEXT,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('running', 'awaiting_answer', 'plan_ready', 'failed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX threads_owner_updated ON threads (owner_sub, updated_at DESC);

-- スレッドの発言。ユーザーの依頼・回答と、Claude Code が返した計画書・質問。
CREATE TABLE messages (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  run_id         TEXT,
  role           TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  kind           TEXT NOT NULL CHECK (kind IN ('request', 'reply', 'plan', 'questions', 'error')),
  title          TEXT,
  body           TEXT NOT NULL,
  questions_json TEXT,
  created_at     INTEGER NOT NULL,
  UNIQUE (thread_id, seq)
);

-- ルーチンの 1 回の実行。コールバックのトークンは SHA-256 だけを持つ。
CREATE TABLE runs (
  id                  TEXT PRIMARY KEY,
  thread_id           TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  owner_sub           TEXT NOT NULL,
  trigger_message_id  TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('firing', 'running', 'completed', 'failed', 'expired')),
  callback_token_hash TEXT NOT NULL,
  session_id          TEXT,
  session_url         TEXT,
  progress_note       TEXT,
  progress_at         INTEGER,
  error               TEXT,
  created_at          INTEGER NOT NULL,
  completed_at        INTEGER,
  expires_at          INTEGER NOT NULL
);
CREATE INDEX runs_thread_created ON runs (thread_id, created_at);
CREATE INDEX runs_owner_created ON runs (owner_sub, created_at);
