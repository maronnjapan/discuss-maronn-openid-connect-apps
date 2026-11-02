/**
 * Comments in place: a comment names the block of the plan it is on (the
 * line the block starts on), and the page shows it right under that block.
 * The routes are driven through the share link, which needs no session.
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppVariables } from '../src/auth/session.js';
import { addComment, addMessage, createThread, listComments, listMessages, setCommentResolved, setShareToken, toPayloadComments } from '../src/db.js';
import type { AppConfig, Bindings } from '../src/env.js';
import { sharedThreadRoutes } from '../src/routes/thread.js';
import { createD1 } from './support/d1.js';

const config = { appOrigin: 'https://planner.example.com', issuer: 'https://idp.example.com', secureCookies: true } as AppConfig;

const PLAN = [
  '# DPoP の実装計画', // 1
  '',
  '## 概要', // 3
  '',
  '本文です。', // 5
  '',
  '- 項目 A', // 7
  '  - 子', // 8
  '',
  '## テスト計画', // 10
  '',
  '| ID | 内容 |', // 12
  '| --- | --- |',
  '| T-1 | 単体 |',
].join('\n');

async function setup() {
  const { db } = createD1();
  const thread = await createThread(db, { ownerSub: 'alice', ownerName: 'Alice', title: 'DPoP' });
  const token = 'a'.repeat(43);
  await setShareToken(db, thread.id, 'alice', token);
  const plan = await addMessage(db, { threadId: thread.id, role: 'assistant', kind: 'plan', title: 'DPoP の実装計画', body: PLAN });
  const app = new Hono<{ Bindings: Bindings; Variables: AppVariables }>();
  app.use('*', async (c, next) => {
    c.set('config', config);
    await next();
  });
  app.route('/', sharedThreadRoutes);
  const env = { DB: db } as Bindings;
  const post = (fields: Record<string, string>) =>
    app.request(`/s/${token}/comments`, { method: 'POST', body: new URLSearchParams({ message_id: plan.id, ...fields }) }, env);
  const page = async () => (await app.request(`/s/${token}`, {}, env)).text();
  const comment = (input: { anchorLine?: number | null; section?: string | null; quote?: string | null; body: string }) =>
    addComment(db, {
      threadId: thread.id,
      messageId: plan.id,
      section: input.section ?? null,
      anchorLine: input.anchorLine ?? null,
      quote: input.quote ?? null,
      body: input.body,
      author: { sub: null, name: 'Bob' },
      limit: { count: 60, since: 0 },
    });
  return { db, thread, plan, post, page, comment };
}

/** The HTML between two marks of the page, which must appear in this order. */
function between(html: string, from: string, to: string): string {
  const start = html.indexOf(from);
  expect(start, `${from} not found`).toBeGreaterThanOrEqual(0);
  const end = html.indexOf(to, start + from.length);
  expect(end, `${to} not found after ${from}`).toBeGreaterThan(start);
  return html.slice(start + from.length, end);
}

describe('POST /comments', () => {
  it('should put a comment on a block, under the section of the block', async () => {
    const { db, thread, post } = await setup();
    const response = await post({ anchor_line: '7', quote: '項目 A', body: 'A を詳しく', section: '別の節' });
    expect(response.status).toBe(303);
    const [comment] = await listComments(db, thread.id);
    expect(response.headers.get('Location')).toBe(`/s/${'a'.repeat(43)}#${comment!.id}`);
    expect(comment).toMatchObject({ anchor_line: 7, section: '概要', quote: '項目 A', body: 'A を詳しく', author_sub: null });
  });

  it('should refuse a place that is not a block of the latest version', async () => {
    const { db, thread, post } = await setup();
    // Line 6 is blank and line 99 is past the end; the nested item on line 8 is a block of its own.
    expect((await post({ anchor_line: '6', body: 'x' })).status).toBe(409);
    expect((await post({ anchor_line: '99', body: 'x' })).status).toBe(409);
    expect((await post({ anchor_line: '1e3', body: 'x' })).status).toBe(400);
    expect((await post({ anchor_line: '0', body: 'x' })).status).toBe(400);
    expect(await listComments(db, thread.id)).toEqual([]);
    expect((await post({ anchor_line: '8', body: '子に' })).status).toBe(303);
    expect((await listComments(db, thread.id)).map((comment) => comment.anchor_line)).toEqual([8]);
  });

  it('should take a comment on the whole plan, and the heading of a section from an older page', async () => {
    const { db, thread, post } = await setup();
    await post({ body: '全体に' });
    await post({ section: 'テスト計画', body: '節に' });
    expect((await listComments(db, thread.id)).map((comment) => [comment.anchor_line, comment.section])).toEqual([
      [null, null],
      [null, 'テスト計画'],
    ]);
  });
});

describe('The thread page', () => {
  it('should show each comment right under its block', async () => {
    const { page, comment } = await setup();
    const onItem = await comment({ anchorLine: 7, section: '概要', quote: '項目 A', body: '項目へのコメント' });
    const onTable = await comment({ anchorLine: 12, section: 'テスト計画', body: '表へのコメント' });
    const html = await page();
    // A list item's comments come after its own text and before its nested list.
    const afterItem = between(html, '<li data-line="7">項目 A', '<ul>');
    expect(afterItem).toContain(`id="${onItem!.id}"`);
    expect(afterItem).toContain('<aside class="comment-thread" data-thread-line="7" aria-label="リストの項目へのコメント">');
    expect(afterItem).toContain('<blockquote class="comment__quote" data-comment-quote-text="true">項目 A</blockquote>');
    expect(between(html, '</table></div>', '</div>')).toContain(`id="${onTable!.id}"`);
    // Nothing else is between the heading of a section and its first block.
    expect(between(html, '概要</h2>', '<p data-line="5">')).toBe('\n');
  });

  it('should show a comment from before comments had a place under the heading of its section', async () => {
    const { page, comment } = await setup();
    const legacy = await comment({ section: 'テスト計画', quote: 'T-1', body: '古いコメント' });
    expect(between(await page(), 'テスト計画</h2>', '<div class="table-wrap" data-line="12">')).toContain(`id="${legacy!.id}"`);
  });

  it('should show the comments on the whole plan after the plan, with the form for one', async () => {
    const { page, comment } = await setup();
    const whole = await comment({ body: '全体へのコメント' });
    const html = await page();
    const footer = between(html, '<section class="comments"', '</section>');
    expect(footer).toContain('未解決 1 件 / 全 1 件');
    expect(footer).toContain('計画書全体へのコメント');
    expect(footer).toContain(`id="${whole!.id}"`);
    // The form names the sections by the line of their heading, for people without a pointer or scripts.
    expect(footer).toContain('<option value="">計画書全体</option><option value="3">概要</option><option value="10">テスト計画</option>');
    expect(html).not.toContain('class="comment-thread"');
  });

  it('should fold the resolved comments of a block', async () => {
    const { db, thread, page, comment } = await setup();
    const open = await comment({ anchorLine: 5, section: '概要', body: 'まだ' });
    const done = await comment({ anchorLine: 5, section: '概要', body: '済んだ' });
    await setCommentResolved(db, thread.id, done!.id, { name: 'Bob' });
    const thread5 = between(await page(), 'data-thread-line="5"', '</aside>');
    expect(thread5.indexOf(`id="${open!.id}"`)).toBeLessThan(thread5.indexOf('<details class="comment-list__resolved"><summary>解決済みのコメント 1 件</summary>'));
    expect(between(thread5, '<details class="comment-list__resolved">', '</details>')).toContain(`id="${done!.id}"`);
  });

  it('should make only the latest version commentable, and keep the comments of an earlier one in place', async () => {
    const { db, thread, plan, page, comment } = await setup();
    const old = await comment({ anchorLine: 5, section: '概要', body: 'v1 へのコメント' });
    await addMessage(db, { threadId: thread.id, role: 'assistant', kind: 'plan', title: 'v2', body: `${PLAN}\n\n追記` });
    const html = await page();
    expect(html).toContain(`<div class="markdown-body plan-body" data-plan-body="${plan.id}">`);
    expect(between(html, `data-plan-body="${plan.id}"`, '</article>')).toContain(`id="${old!.id}"`);
    expect(html.match(/data-commentable="true"/g)).toHaveLength(1);
    expect(html.match(/<template data-comment-template=/g)).toHaveLength(1);
    // The earlier version is not commentable: no button to add a comment there.
    expect(html).not.toContain('data-comment-add="5"');
  });
});

describe('toPayloadComments', () => {
  it('should give the routine the line of each comment and the start of its block', async () => {
    const { db, thread, comment } = await setup();
    await comment({ anchorLine: 7, section: '概要', body: '項目へ' });
    await comment({ body: '全体へ' });
    // A line that names no block (the renderer changed since) goes without one.
    await comment({ anchorLine: 6, section: '概要', body: '空行へ' });
    const payload = toPayloadComments(await listComments(db, thread.id), await listMessages(db, thread.id));
    expect(payload.map(({ line, excerpt, section, body }) => ({ line, excerpt, section, body }))).toEqual([
      { line: 7, excerpt: '- 項目 A - 子', section: '概要', body: '項目へ' },
      { line: undefined, excerpt: undefined, section: null, body: '全体へ' },
      { line: undefined, excerpt: undefined, section: '概要', body: '空行へ' },
    ]);
  });
});
