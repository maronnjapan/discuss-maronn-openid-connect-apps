import { describe, expect, it } from 'vitest';
import { createD1 } from './support/d1.js';

describe('migration 0002', () => {
  function populated() {
    const d1 = createD1({ migrations: ['0001_init.sql'] });
    d1.raw.exec(`
      INSERT INTO threads (id, owner_sub, owner_name, title, status, created_at, updated_at) VALUES ('thr_1', 'alice', 'Alice', 'DPoP', 'running', 1, 3);
      INSERT INTO messages (id, thread_id, seq, run_id, role, kind, title, body, created_at) VALUES
        ('msg_1', 'thr_1', 1, NULL, 'user', 'request', 'DPoP', '依頼', 1),
        ('msg_2', 'thr_1', 2, 'run_1', 'assistant', 'plan', '計画', '# 計画', 2),
        ('msg_3', 'thr_1', 3, NULL, 'user', 'reply', NULL, '直して', 3);
      INSERT INTO runs (id, thread_id, owner_sub, trigger_message_id, status, callback_token_hash, created_at, expires_at) VALUES
        ('run_1', 'thr_1', 'alice', 'msg_1', 'completed', 'h1', 1, 100),
        ('run_2', 'thr_1', 'alice', 'msg_3', 'running', 'h2', 3, 100),
        ('run_3', 'thr_1', 'alice', 'msg_3', 'running', 'h3', 4, 100);
    `);
    d1.applyMigration('0002_versions_comments_sharing.sql');
    return d1;
  }

  it('should keep the messages and give the messages of people their author', () => {
    const { raw } = populated();
    expect(raw.prepare('SELECT id, kind, author_sub, author_name FROM messages ORDER BY seq').all().map((row) => ({ ...row }))).toEqual([
      { id: 'msg_1', kind: 'request', author_sub: 'alice', author_name: 'Alice' },
      { id: 'msg_2', kind: 'plan', author_sub: null, author_name: null },
      { id: 'msg_3', kind: 'reply', author_sub: 'alice', author_name: 'Alice' },
    ]);
  });

  it('should keep one active run per thread, the newest, and mark the existing runs as plan runs', () => {
    const { raw } = populated();
    expect(raw.prepare('SELECT id, status, task FROM runs ORDER BY id').all().map((row) => ({ ...row }))).toEqual([
      { id: 'run_1', status: 'completed', task: 'plan' },
      { id: 'run_2', status: 'expired', task: 'plan' },
      { id: 'run_3', status: 'running', task: 'plan' },
    ]);
    expect(() =>
      raw.exec("INSERT INTO runs (id, thread_id, owner_sub, trigger_message_id, status, callback_token_hash, created_at, expires_at) VALUES ('run_4', 'thr_1', 'alice', 'msg_3', 'firing', 'h4', 5, 100)"),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('should still delete the messages and comments of a deleted thread', () => {
    const { raw } = populated();
    raw.exec("INSERT INTO comments (id, thread_id, message_id, body, created_at) VALUES ('cmt_1', 'thr_1', 'msg_2', 'x', 5)");
    raw.exec("DELETE FROM threads WHERE id = 'thr_1'");
    expect(raw.prepare('SELECT (SELECT COUNT(*) FROM messages) AS messages, (SELECT COUNT(*) FROM comments) AS comments, (SELECT COUNT(*) FROM runs) AS runs').get()).toEqual({
      messages: 0,
      comments: 0,
      runs: 0,
    });
  });
});
