-- 計画書の版と書き手、コメント、共有リンク、実装用プロンプト。時刻はすべて epoch 秒。

-- messages を作り直す。SQLite は CHECK 制約を変えられないため、kind に
-- prompt_request（実装用プロンプトの依頼）と implementation_prompt（実装用プロンプト）を
-- 足すには、新しい表へ写して置き換える。messages を参照する外部キーは無いので、
-- 置き換えで消える行は無い。
CREATE TABLE messages_new (
  id              TEXT PRIMARY KEY,
  thread_id       TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  run_id          TEXT,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  kind            TEXT NOT NULL CHECK (kind IN ('request', 'reply', 'plan', 'questions', 'error', 'prompt_request', 'implementation_prompt')),
  title           TEXT,
  body            TEXT NOT NULL,
  questions_json  TEXT,
  -- 書いた人。ログインしたユーザーなら sub と名前、共有リンクの閲覧者なら名前だけ
  -- （sub は NULL）。Claude Code の発言はどちらも NULL。
  -- role が user で kind が plan の行は、人が編集した計画書の版。
  author_sub      TEXT,
  author_name     TEXT,
  -- 計画書の版の変更点（Claude Code の要約か、編集した人のメモ）と、実装用プロンプトの整形メモ。
  change_summary  TEXT,
  -- その発言が前提にした計画書の版（messages.id）：編集した版、投稿した時点の最新版、
  -- Claude Code が結果を返した時点の最新版（実装用プロンプトなら、その元にした版）。
  base_message_id TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE (thread_id, seq)
);

-- これまでのユーザーの発言は、すべてスレッドの作成者が書いたもの。
INSERT INTO messages_new (id, thread_id, seq, run_id, role, kind, title, body, questions_json, author_sub, author_name, created_at)
SELECT m.id, m.thread_id, m.seq, m.run_id, m.role, m.kind, m.title, m.body, m.questions_json,
       CASE WHEN m.role = 'user' THEN t.owner_sub END,
       CASE WHEN m.role = 'user' THEN t.owner_name END,
       m.created_at
FROM messages AS m JOIN threads AS t ON t.id = m.thread_id;

DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;

-- 計画書へのコメント。未解決のものは、次にルーチンを起動するときの依頼に含める。
-- message_id には外部キーを付けない。messages をまた作り直すとき、DROP TABLE の
-- 暗黙の DELETE でコメントまで消えないようにするため（スレッドの削除では消える）。
CREATE TABLE comments (
  id               TEXT PRIMARY KEY,
  thread_id        TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  -- コメントした計画書の版（messages.id、kind が plan の行）。
  message_id       TEXT NOT NULL,
  -- 対象の節の見出しと、引用した箇所（どちらも任意）。
  section          TEXT,
  quote            TEXT,
  body             TEXT NOT NULL,
  author_sub       TEXT,
  author_name      TEXT,
  created_at       INTEGER NOT NULL,
  -- 解決した時刻と、誰が解決したか（人か、指摘を反映した Claude Code の計画書か）。
  resolved_at      INTEGER,
  resolved_by      TEXT CHECK (resolved_by IN ('user', 'assistant')),
  resolved_by_name TEXT,
  -- Claude Code の返答（どう反映したか、反映しない理由）。
  reply            TEXT,
  reply_run_id     TEXT,
  reply_at         INTEGER
);
CREATE INDEX comments_thread_created ON comments (thread_id, created_at);

-- 共有リンク（/s/<share_token>）。URL を知っている人は、ログインせずにこのスレッドを
-- 閲覧し、投稿とコメントができる。作成者があとから何度でも URL をコピーできるよう、
-- ハッシュにせずそのまま持つ。作り直すと以前の URL は使えなくなる。
ALTER TABLE threads ADD COLUMN share_token TEXT;
ALTER TABLE threads ADD COLUMN shared_at INTEGER;
CREATE UNIQUE INDEX threads_share_token ON threads (share_token);

-- ルーチンの作業の種類：計画書づくり（plan）か、計画書から実装用プロンプトを作る
-- （implementation_prompt）か。
ALTER TABLE runs ADD COLUMN task TEXT NOT NULL DEFAULT 'plan' CHECK (task IN ('plan', 'implementation_prompt'));

-- 1 つのスレッドで同時に動く run は 1 つまで。run は、作業中の run が無いことを
-- 条件にした INSERT で作る（src/db.ts の RUN_ALLOWED）。この索引はその念押し。
-- 以前の版で同時に動いてしまった run があれば、最も新しい 1 つを残して時間切れにする。
UPDATE runs
SET status = 'expired',
    error = '同じスレッドで同時に動いていたため、時間切れとして扱いました。',
    completed_at = CAST(strftime('%s', 'now') AS INTEGER)
WHERE status IN ('firing', 'running')
  AND id <> (
    SELECT r.id FROM runs AS r
    WHERE r.thread_id = runs.thread_id AND r.status IN ('firing', 'running')
    ORDER BY r.created_at DESC, r.rowid DESC
    LIMIT 1
  );
CREATE UNIQUE INDEX runs_one_active_per_thread ON runs (thread_id) WHERE status IN ('firing', 'running');
