import { describe, expect, it } from 'vitest';
import { addComment, createThread, listComments, listMessages, listRuns, type CommentRow } from '../src/db.js';
import type { AppConfig } from '../src/env.js';
import { postMessage, recordCallback } from '../src/service.js';
import { createD1 } from './support/d1.js';

const config = {
  appOrigin: 'https://planner.example.com',
  routine: { fireUrl: 'https://api.example.com/v1/claude_code/routines/trig_1/fire', token: 'sk-ant-oat01-test' },
  runsPerHourLimit: 10,
  runTimeoutSeconds: 3600,
} as AppConfig;

// The fire succeeds, so a started run stays active.
const fire = (async () =>
  Response.json({ type: 'routine_fire', claude_code_session_id: 'session_1', claude_code_session_url: 'https://claude.ai/code/session_1' })) as typeof fetch;

const guest = { sub: null, name: 'Bob' };

describe('postMessage', () => {
  // Anyone with a share link can post: parallel posts must not start parallel runs on one version of the plan.
  it('should start one run when visitors post to a thread in parallel', async () => {
    const { db } = createD1();
    const thread = await createThread(db, { ownerSub: 'alice', ownerName: 'Alice', title: 'DPoP' });
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, index) => postMessage(db, config, { thread, kind: 'reply', body: `返信 ${index}`, author: guest }, fire)),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toEqual({ ok: false, reason: 'このスレッドでは Claude Code が作業中です。結果が返るまでお待ちください。' });
    expect(await listRuns(db, thread.id)).toHaveLength(1);
    // A refused post leaves no message behind.
    expect(await listMessages(db, thread.id)).toHaveLength(1);
  });

  it('should not start more runs than the hourly limit of the owner, also in parallel', async () => {
    const { db } = createD1();
    const threads = await Promise.all(
      Array.from({ length: 25 }, (_, index) => createThread(db, { ownerSub: 'alice', ownerName: 'Alice', title: `T${index}` })),
    );
    const results = await Promise.all(threads.map((thread) => postMessage(db, config, { thread, kind: 'reply', body: 'x', author: guest }, fire)));
    expect(results.filter((result) => result.ok)).toHaveLength(10);
    expect(results.find((result) => !result.ok)).toEqual({
      ok: false,
      reason: '1 時間あたりの依頼回数の上限（10 回）に達しました。しばらくしてから送ってください。',
    });
  });
});

describe('recordCallback comment replies', () => {
  async function threadWithComment() {
    const { db } = createD1();
    const thread = await createThread(db, { ownerSub: 'alice', ownerName: 'Alice', title: 'DPoP' });
    const posted = await postMessage(db, config, { thread, kind: 'request', body: '依頼', author: { sub: 'alice', name: 'Alice' } }, fire);
    if (!posted.ok) throw new Error(posted.reason);
    await recordCallback(db, config, posted.run, { kind: 'plan', markdown: '# 計画 v1', questions: [], commentReplies: [] });
    const plan = (await listMessages(db, thread.id)).find((message) => message.kind === 'plan')!;
    const comment = (await addComment(db, {
      threadId: thread.id,
      messageId: plan.id,
      section: null,
      quote: null,
      body: 'E2E も',
      author: guest,
      limit: { count: 60, since: 0 },
    }))!;
    const next = await postMessage(db, config, { thread, kind: 'reply', body: '直して', author: guest }, fire);
    if (!next.ok) throw new Error(next.reason);
    return { db, thread, comment, run: next.run };
  }

  it('should resolve the comments a plan addresses', async () => {
    const { db, thread, comment, run } = await threadWithComment();
    await recordCallback(db, config, run, {
      kind: 'plan',
      markdown: '# 計画 v2',
      questions: [],
      changes: 'E2E を足した',
      commentReplies: [{ id: comment.id, resolved: true, reply: 'テスト計画に足した' }],
    });
    const [after] = await listComments(db, thread.id);
    expect(after).toMatchObject<Partial<CommentRow>>({ resolved_by: 'assistant', reply: 'テスト計画に足した' });
    expect(after!.resolved_at).not.toBeNull();
  });

  // Questions change no plan, so they leave the comments open (with the reply).
  it('should keep the comments open when Claude Code answers with questions', async () => {
    const { db, thread, comment, run } = await threadWithComment();
    await recordCallback(db, config, run, {
      kind: 'questions',
      markdown: '確認させてください',
      questions: [{ id: 'q1', question: 'E2E はどの範囲？' }],
      commentReplies: [{ id: comment.id, resolved: true, reply: 'q1 の回答を待って反映する' }],
    });
    const [after] = await listComments(db, thread.id);
    expect(after).toMatchObject<Partial<CommentRow>>({ resolved_at: null, resolved_by: null, reply: 'q1 の回答を待って反映する' });
  });
});

describe('addComment', () => {
  it('should take no more comments than the limit, also in parallel', async () => {
    const { db } = createD1();
    const thread = await createThread(db, { ownerSub: 'alice', ownerName: 'Alice', title: 'DPoP' });
    const posted = await postMessage(db, config, { thread, kind: 'request', body: '依頼', author: guest }, fire);
    if (!posted.ok) throw new Error(posted.reason);
    await recordCallback(db, config, posted.run, { kind: 'plan', markdown: '# 計画', questions: [], commentReplies: [] });
    const plan = (await listMessages(db, thread.id)).find((message) => message.kind === 'plan')!;
    const added = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        addComment(db, { threadId: thread.id, messageId: plan.id, section: null, quote: null, body: `c${index}`, author: guest, limit: { count: 5, since: 0 } }),
      ),
    );
    expect(added.filter((comment) => comment !== null)).toHaveLength(5);
  });
});
