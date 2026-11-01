/** @jsxImportSource hono/jsx */
/**
 * The pages and forms of one thread, for its owner (/plans/{id}, signed in)
 * and for the visitors of its share link (/s/{token}, without signing in).
 *
 * Both read the conversation and every version of the plan, post replies
 * (which start runs), comment on the plan and resolve comments, and ask for
 * an implementation prompt. Only the owner edits the plan, deletes comments,
 * manages the share link and deletes the thread. Runs started from a share
 * link count against the owner's hourly limit, and comments against a limit
 * per thread and hour.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { currentSession, type AppVariables, type CurrentUser } from '../auth/session.js';
import { composePromptRequest, composeReply, formString, formStrings, guestName, LIMITS } from '../compose.js';
import { randomToken } from '../crypto.js';
import {
  ACTIVE_RUN_STATUSES,
  addComment,
  addEditedPlan,
  authorLabel,
  countCommentsSince,
  countMessages,
  deleteComment,
  deleteThread,
  expireStaleRuns,
  findActiveRun,
  getMessage,
  getThread,
  getThreadByShareToken,
  listComments,
  listMessages,
  listRuns,
  messageQuestions,
  now,
  planVersionsById,
  setCommentResolved,
  setShareToken,
  setThreadStatus,
  touchThread,
  type Author,
  type CommentRow,
  type MessageRow,
  type RunRow,
  type ThreadRow,
} from '../db.js';
import type { AppConfig, Bindings } from '../env.js';
import { renderMarkdown } from '../markdown.js';
import { diffHunks, sectionChanges } from '../plan-diff.js';
import { COMMENT_ID, firstHeading, LIMITS as RESULT_LIMITS } from '../routine/callback.js';
import { postMessage, retryRun, runBlocker } from '../service.js';
import { ErrorPage } from '../views/pages.js';
import { DiffPage, EditPlanPage, ThreadPage, type CommentView, type ThreadAccessView, type ThreadViewModel, type TimelineItem } from '../views/thread.js';

export interface ThreadAccess {
  thread: ThreadRow;
  mode: 'owner' | 'guest';
  /** /plans/{id} or /s/{token}. */
  basePath: string;
  /** The signed-in user; on a share page, null for a visitor without a session. */
  user: CurrentUser | null;
}

type ThreadEnv = { Bindings: Bindings; Variables: AppVariables & { access: ThreadAccess } };
type ThreadContext = Context<ThreadEnv>;

/** The comments a thread takes per hour, from everyone who can comment. */
export const COMMENTS_PER_HOUR_LIMIT = 60;

export const shareUrl = (config: AppConfig, token: string) => `${config.appOrigin}/s/${token}`;

const NOTICES: Record<string, string> = {
  'share-created': '共有リンクを作りました。URL を知っている人は、ログインせずにこのスレッドを閲覧し、投稿とコメントができます。',
  'share-rotated': '共有リンクを作り直しました。以前の URL は使えません。',
  'share-stopped': '共有をやめました。以前の URL は使えません。',
  'plan-saved': '編集した計画書を新しい版として保存しました。次に Claude Code へ送るときは、この版を元に作業します。',
};

function accessView(access: ThreadAccess): ThreadAccessView {
  return {
    mode: access.mode,
    basePath: access.basePath,
    anonymous: access.user === null,
    viewerIsOwner: access.user?.sub === access.thread.owner_sub,
    viewerSub: access.user?.sub ?? null,
  };
}

/** Who acts: the signed-in user, or a visitor of the share link with the name given in the form. */
function actor(access: ThreadAccess, form: Record<string, unknown>): Author {
  if (access.user) return { sub: access.user.sub, name: access.user.name ?? access.user.sub };
  return { sub: null, name: guestName(formString(form, 'author_name')) };
}

/** Pages of a share link are kept out of caches and search engines. */
function pageHeaders(access: ThreadAccess): Record<string, string> {
  return access.mode === 'guest' ? { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } : {};
}

function notFound(c: ThreadContext) {
  return c.html(
    <ErrorPage title="見つかりません" message="指定された計画は存在しないか、閲覧できません。" user={c.get('access')?.user ?? null} />,
    404,
  );
}

const latestOf = (messages: MessageRow[], kind: MessageRow['kind']) => [...messages].reverse().find((message) => message.kind === kind);

// ---------------------------------------------------------------------------
// The thread view

function commentView(comment: CommentRow): CommentView {
  return {
    comment,
    html: renderMarkdown(comment.body, { idPrefix: comment.id }).html,
    replyHtml: comment.reply ? renderMarkdown(comment.reply, { idPrefix: `${comment.id}-reply` }).html : null,
  };
}

/** Marks a run whose result never came as expired, and the thread as failed. */
async function expireRuns(db: D1Database, thread: ThreadRow): Promise<void> {
  if (await expireStaleRuns(db, thread.id)) {
    await setThreadStatus(db, thread.id, 'failed');
    thread.status = 'failed';
  }
}

/** What the polling of a running thread compares: a new message, the end of the run, or a new progress note. */
const signatureOf = (activeRun: RunRow | null, messageCount: number) =>
  `${activeRun?.status ?? 'idle'}:${messageCount}:${activeRun?.progress_at ?? 0}`;

export async function loadThreadView(db: D1Database, thread: ThreadRow): Promise<ThreadViewModel & { messages: MessageRow[] }> {
  await expireRuns(db, thread);
  const [messages, runs, comments] = await Promise.all([listMessages(db, thread.id), listRuns(db, thread.id), listComments(db, thread.id)]);
  const latestRunByMessage = new Map<string, RunRow>();
  for (const run of runs) latestRunByMessage.set(run.trigger_message_id, run);
  const versions = planVersionsById(messages);
  const commentsByPlan = new Map<string, CommentRow[]>();
  for (const comment of comments) commentsByPlan.set(comment.message_id, [...(commentsByPlan.get(comment.message_id) ?? []), comment]);
  const latestPlanId = latestOf(messages, 'plan')?.id;
  const latestPromptId = latestOf(messages, 'implementation_prompt')?.id;

  let previousPlan: MessageRow | undefined;
  const items: TimelineItem[] = messages.map((message) => {
    const rendered = renderMarkdown(message.body, { idPrefix: message.id });
    const run = latestRunByMessage.get(message.id);
    const item: TimelineItem = {
      message,
      html: rendered.html,
      headings: rendered.headings,
      questions: messageQuestions(message),
      ...(run ? { run } : {}),
    };
    if (message.change_summary) item.summaryHtml = renderMarkdown(message.change_summary, { idPrefix: `${message.id}-summary` }).html;
    if (message.kind === 'plan') {
      item.planVersion = versions.get(message.id)!;
      item.isLatest = message.id === latestPlanId;
      if (previousPlan) item.sectionChanges = sectionChanges(previousPlan.body, message.body);
      item.comments = (commentsByPlan.get(message.id) ?? []).map(commentView);
      previousPlan = message;
    }
    if (message.kind === 'implementation_prompt') item.isLatest = message.id === latestPromptId;
    const basePlanVersion = message.base_message_id ? versions.get(message.base_message_id) : undefined;
    if ((message.kind === 'prompt_request' || message.kind === 'implementation_prompt') && basePlanVersion) item.basePlanVersion = basePlanVersion;
    return item;
  });

  const activeRun = [...runs].reverse().find((run) => ACTIVE_RUN_STATUSES.includes(run.status)) ?? null;
  // The answer form stays while questions are Claude Code's last word, also after people edited the plan.
  const lastTurn = [...items].reverse().find((item) => !(item.message.role === 'user' && item.message.kind === 'plan'));
  return {
    thread,
    items,
    activeRun,
    latestRun: runs[runs.length - 1] ?? null,
    pendingQuestions: lastTurn?.message.kind === 'questions' ? lastTurn : null,
    latestPlan: items.find((item) => item.message.id === latestPlanId) ?? null,
    openComments: comments.filter((comment) => comment.resolved_at === null),
    progressHtml: activeRun?.progress_note ? renderMarkdown(activeRun.progress_note, { idPrefix: 'progress' }).html : null,
    signature: signatureOf(activeRun, messages.length),
    messages,
  };
}

async function renderThread(
  c: ThreadContext,
  extra: { error?: string | null; notice?: string | null; openSharePanel?: boolean } = {},
  status: 200 | 400 | 409 | 429 = 200,
) {
  const access = c.get('access');
  const view = await loadThreadView(c.env.DB, access.thread);
  const token = access.mode === 'owner' ? access.thread.share_token : null;
  return c.html(
    <ThreadPage
      access={accessView(access)}
      user={access.user}
      view={view}
      shareUrl={token ? shareUrl(c.get('config'), token) : null}
      error={extra.error ?? null}
      notice={extra.notice ?? null}
      openSharePanel={extra.openSharePanel === true}
    />,
    status,
    pageHeaders(access),
  );
}

function markdownResponse(c: ThreadContext, body: string, filename: string, disposition: 'inline' | 'attachment') {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return c.body(body.endsWith('\n') ? body : `${body}\n`, 200, {
    ...pageHeaders(c.get('access')),
    'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Disposition': `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
  });
}

// ---------------------------------------------------------------------------
// The routes

function threadRoutes(base: '/plans/:id' | '/s/:token', resolve: (c: ThreadContext) => Promise<ThreadAccess | null>) {
  const app = new Hono<ThreadEnv>();
  const load: MiddlewareHandler<ThreadEnv> = async (c, next) => {
    const access = await resolve(c);
    if (!access) return notFound(c);
    c.set('access', access);
    await next();
  };
  // `${base}/*` matches the base path itself too.
  app.use(`${base}/*`, load);
  const ownerOnly: MiddlewareHandler<ThreadEnv> = async (c, next) => {
    if (c.get('access').mode !== 'owner') return notFound(c);
    await next();
  };

  app.get(base, (c) => {
    const done = c.req.query('done') ?? '';
    return renderThread(c, { notice: NOTICES[done] ?? null, openSharePanel: done.startsWith('share-') });
  });

  /** Polled by public/assets/app.js every few seconds while a run is active: no rendering, two small queries. */
  app.get(`${base}/status`, async (c) => {
    const { thread } = c.get('access');
    await expireRuns(c.env.DB, thread);
    const [activeRun, messageCount] = await Promise.all([findActiveRun(c.env.DB, thread.id), countMessages(c.env.DB, thread.id)]);
    return c.json(
      { status: thread.status, running: activeRun !== null, signature: signatureOf(activeRun, messageCount) },
      200,
      { 'Cache-Control': 'no-store' },
    );
  });

  app.post(`${base}/messages`, async (c) => {
    const access = c.get('access');
    const { thread, basePath } = access;
    const blocker = await runBlocker(c.env.DB, c.get('config'), thread.owner_sub, thread.id);
    if (blocker) return renderThread(c, { error: blocker }, 409);

    const form = await c.req.parseBody();
    const [messages, comments] = await Promise.all([listMessages(c.env.DB, thread.id), listComments(c.env.DB, thread.id)]);
    const lastTurn = [...messages].reverse().find((message) => !(message.role === 'user' && message.kind === 'plan'));
    const questions = lastTurn?.kind === 'questions' ? messageQuestions(lastTurn) : [];
    const openComments = comments.filter((comment) => comment.resolved_at === null).length;
    const body = composeReply(questions, form, { openComments });
    if (!body) return renderThread(c, { error: '回答かメッセージを入力してください。' }, 400);

    const posted = await postMessage(c.env.DB, c.get('config'), {
      thread,
      kind: 'reply',
      body,
      author: actor(access, form),
      baseMessageId: latestOf(messages, 'plan')?.id ?? null,
    });
    if (!posted.ok) return renderThread(c, { error: posted.reason }, 409);
    return c.redirect(`${basePath}#${posted.message.id}`, 303);
  });

  /** Fires the routine again for the latest message of a person, after a failed or expired run. */
  app.post(`${base}/retry`, async (c) => {
    const access = c.get('access');
    const { thread, basePath } = access;
    const blocker = await runBlocker(c.env.DB, c.get('config'), thread.owner_sub, thread.id);
    if (blocker) return renderThread(c, { error: blocker }, 409);

    // The latest request, reply or prompt request is the one to retry, also when
    // Claude Code answered it with an error message (that stays in the history it receives).
    const [messages, runs] = await Promise.all([listMessages(c.env.DB, thread.id), listRuns(c.env.DB, thread.id)]);
    const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user' && message.kind !== 'plan');
    const latestRun = runs[runs.length - 1];
    const retryable =
      latestUserMessage &&
      latestRun?.trigger_message_id === latestUserMessage.id &&
      (latestRun.status === 'failed' || latestRun.status === 'expired');
    if (!retryable) return renderThread(c, { error: '再実行できる依頼がありません。' }, 400);
    const retried = await retryRun(c.env.DB, c.get('config'), { thread, triggerMessage: latestUserMessage, requester: actor(access, await c.req.parseBody()) });
    if (!retried.ok) return renderThread(c, { error: retried.reason }, 409);
    return c.redirect(basePath, 303);
  });

  /** Asks Claude Code to turn the latest plan into a prompt for an AI coding agent. */
  app.post(`${base}/prompt`, async (c) => {
    const access = c.get('access');
    const { thread, basePath } = access;
    const blocker = await runBlocker(c.env.DB, c.get('config'), thread.owner_sub, thread.id);
    if (blocker) return renderThread(c, { error: blocker }, 409);

    const form = await c.req.parseBody();
    const messages = await listMessages(c.env.DB, thread.id);
    const plans = messages.filter((message) => message.kind === 'plan');
    const latest = plans[plans.length - 1];
    if (!latest) return renderThread(c, { error: '計画書がまだありません。' }, 400);
    if (formString(form, 'base') !== latest.id) {
      return renderThread(c, { error: `計画書が更新されています（最新は v${plans.length}）。最新の計画書を確かめてから、もう一度依頼してください。` }, 409);
    }
    const instructions = formString(form, 'instructions');
    if (instructions.length > LIMITS.instructions) return renderThread(c, { error: '整形の指示が長すぎます。' }, 400);

    const posted = await postMessage(c.env.DB, c.get('config'), {
      thread,
      kind: 'prompt_request',
      body: composePromptRequest(plans.length, instructions),
      author: actor(access, form),
      baseMessageId: latest.id,
    });
    if (!posted.ok) return renderThread(c, { error: posted.reason }, 409);
    return c.redirect(`${basePath}#${posted.message.id}`, 303);
  });

  // --- Comments --------------------------------------------------------------

  app.post(`${base}/comments`, async (c) => {
    const access = c.get('access');
    const { thread, basePath } = access;
    const form = await c.req.parseBody();
    const body = formString(form, 'body');
    const quote = formString(form, 'quote');
    const section = formString(form, 'section').replace(/\s+/g, ' ');
    if (!body) return renderThread(c, { error: 'コメントを入力してください。' }, 400);
    if (body.length > LIMITS.comment || quote.length > LIMITS.quote || section.length > LIMITS.section) {
      return renderThread(c, { error: 'コメントか引用が長すぎます。' }, 400);
    }
    const limited = `このスレッドへのコメントは 1 時間に ${COMMENTS_PER_HOUR_LIMIT} 件までです。しばらくしてから書いてください。`;
    const since = now() - 3600;
    if ((await countCommentsSince(c.env.DB, thread.id, since)) >= COMMENTS_PER_HOUR_LIMIT) return renderThread(c, { error: limited }, 429);
    // Comments go on the latest version, the one the next run starts from.
    const latest = latestOf(await listMessages(c.env.DB, thread.id), 'plan');
    if (!latest || formString(form, 'message_id') !== latest.id) {
      return renderThread(c, { error: '計画書が更新されています。最新の版を読んでから、もう一度コメントしてください。' }, 409);
    }
    const comment = await addComment(c.env.DB, {
      threadId: thread.id,
      messageId: latest.id,
      section: section || null,
      quote: quote || null,
      body,
      author: actor(access, form),
      limit: { count: COMMENTS_PER_HOUR_LIMIT, since },
    });
    // The insert checks the limit again, for comments posted in parallel.
    if (!comment) return renderThread(c, { error: limited }, 429);
    await touchThread(c.env.DB, thread.id);
    return c.redirect(`${basePath}#${comment.id}`, 303);
  });

  for (const action of ['resolve', 'reopen'] as const) {
    app.post(`${base}/comments/:commentId/${action}`, async (c) => {
      const access = c.get('access');
      const commentId = c.req.param('commentId') ?? '';
      if (!COMMENT_ID.test(commentId)) return notFound(c);
      const by = access.user ? { name: access.user.name ?? access.user.sub } : { name: 'ゲスト' };
      await setCommentResolved(c.env.DB, access.thread.id, commentId, action === 'resolve' ? by : null);
      return c.redirect(`${access.basePath}#${commentId}`, 303);
    });
  }

  app.post(`${base}/comments/:commentId/delete`, ownerOnly, async (c) => {
    const access = c.get('access');
    const commentId = c.req.param('commentId') ?? '';
    if (COMMENT_ID.test(commentId)) await deleteComment(c.env.DB, access.thread.id, commentId);
    return c.redirect(access.basePath, 303);
  });

  // --- Editing the plan (owner) ----------------------------------------------

  async function editPage(
    c: ThreadContext,
    values: { markdown?: string; note?: string; resolve?: string[]; error?: string },
    status: 200 | 400 | 409 = 200,
  ) {
    const access = c.get('access');
    const [messages, comments] = await Promise.all([listMessages(c.env.DB, access.thread.id), listComments(c.env.DB, access.thread.id)]);
    const versions = planVersionsById(messages);
    const latest = latestOf(messages, 'plan');
    if (!latest) return notFound(c);
    return c.html(
      <EditPlanPage
        user={access.user!}
        thread={access.thread}
        basePath={access.basePath}
        plan={{ id: latest.id, version: versions.get(latest.id)! }}
        markdown={values.markdown ?? latest.body}
        note={values.note ?? ''}
        openComments={comments
          .filter((comment) => comment.resolved_at === null)
          .map((comment) => ({ comment, planVersion: versions.get(comment.message_id) ?? 0 }))}
        resolve={values.resolve ?? []}
        error={values.error ?? null}
      />,
      status,
    );
  }

  app.get(`${base}/plan/edit`, ownerOnly, async (c) => {
    if (await findActiveRun(c.env.DB, c.get('access').thread.id)) {
      return renderThread(c, { error: 'Claude Code が作業中のため、計画書は編集できません。結果が返ってから編集してください。' }, 409);
    }
    return editPage(c, {});
  });

  app.post(`${base}/plan`, ownerOnly, async (c) => {
    const access = c.get('access');
    const form = await c.req.parseBody({ all: true });
    const markdown = formString(form, 'markdown');
    const note = formString(form, 'note').replace(/\s+/g, ' ');
    const resolve = formStrings(form, 'resolve').filter((id) => COMMENT_ID.test(id));
    const again = (error: string, status: 400 | 409) => editPage(c, { markdown, note, resolve, error }, status);

    const messages = await listMessages(c.env.DB, access.thread.id);
    const plans = messages.filter((message) => message.kind === 'plan');
    const latest = plans[plans.length - 1];
    if (!latest) return notFound(c);
    if (!markdown) return again('計画書が空です。', 400);
    if (markdown.length > RESULT_LIMITS.markdown) return again(`計画書は ${RESULT_LIMITS.markdown.toLocaleString('en-US')} 文字までです。`, 400);
    if (note.length > LIMITS.editNote) return again('変更内容のメモが長すぎます。', 400);
    if (formString(form, 'base') !== latest.id) {
      return again(
        `編集している間に計画書が更新されました（最新は v${plans.length}）。あなたの編集内容は下に残しています。最新版との違いを確かめてから保存し直してください。`,
        409,
      );
    }
    if (markdown === latest.body.replace(/\r\n?/g, '\n').trim()) return again('計画書が変わっていません。', 400);

    const user = access.user!;
    const saved = await addEditedPlan(c.env.DB, {
      threadId: access.thread.id,
      baseMessageId: latest.id,
      title: firstHeading(markdown) ?? latest.title,
      body: markdown,
      note: note || null,
      author: { sub: user.sub, name: user.name ?? user.sub },
      resolveCommentIds: resolve,
    });
    if (!saved) return again('計画書が更新されたか、Claude Code が作業を始めたため、保存できませんでした。', 409);
    return c.redirect(`${access.basePath}?done=plan-saved#${saved.id}`, 303);
  });

  // --- Reading the plan --------------------------------------------------------

  app.get(`${base}/plan.md`, async (c) => {
    const { thread } = c.get('access');
    const plan = latestOf(await listMessages(c.env.DB, thread.id), 'plan');
    if (!plan) return notFound(c);
    return markdownResponse(c, plan.body, `${thread.title}.md`, 'attachment');
  });

  app.get(`${base}/messages/:file`, async (c) => {
    const { thread } = c.get('access');
    const file = c.req.param('file') ?? '';
    if (!file.endsWith('.md')) return notFound(c);
    const message = await getMessage(c.env.DB, thread.id, file.slice(0, -3));
    if (!message) return notFound(c);
    return markdownResponse(c, message.body, `${thread.title}-${message.seq}.md`, 'inline');
  });

  /** What changed from the previous version to this one. */
  app.get(`${base}/versions/:version/diff`, async (c) => {
    const access = c.get('access');
    const version = /^[1-9][0-9]{0,4}$/.test(c.req.param('version') ?? '') ? Number(c.req.param('version')) : 0;
    const plans = (await listMessages(c.env.DB, access.thread.id)).filter((message) => message.kind === 'plan');
    const from = plans[version - 2];
    const to = plans[version - 1];
    if (!from || !to) return notFound(c);
    const label = (message: MessageRow) => (message.role === 'assistant' ? 'Claude Code' : `${authorLabel(message)} が編集`);
    return c.html(
      <DiffPage
        user={access.user}
        guest={access.mode === 'guest'}
        thread={access.thread}
        basePath={access.basePath}
        from={{ version: version - 1, author: label(from) }}
        to={{ version, author: label(to), summary: to.change_summary }}
        hunks={diffHunks(from.body, to.body)}
        sectionChanges={sectionChanges(from.body, to.body)}
      />,
      200,
      pageHeaders(access),
    );
  });

  /** The preview tab of the Markdown fields: the same renderer as the thread page. */
  app.post(`${base}/preview`, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { markdown?: unknown };
    const markdown = typeof body.markdown === 'string' ? body.markdown.slice(0, 50_000) : '';
    return c.json({ html: renderMarkdown(markdown, { idPrefix: 'preview' }).html });
  });

  // --- The owner's controls ------------------------------------------------------

  app.post(`${base}/delete`, ownerOnly, async (c) => {
    const access = c.get('access');
    await deleteThread(c.env.DB, access.thread.id, access.thread.owner_sub);
    return c.redirect('/', 303);
  });

  for (const [path, done] of [
    ['share', 'share-created'],
    ['share/rotate', 'share-rotated'],
    ['share/delete', 'share-stopped'],
  ] as const) {
    app.post(`${base}/${path}`, ownerOnly, async (c) => {
      const { thread, basePath } = c.get('access');
      // Creating a link keeps one that exists; rotating replaces it; deleting removes it.
      const token = path === 'share/delete' ? null : path === 'share' && thread.share_token ? thread.share_token : randomToken();
      await setShareToken(c.env.DB, thread.id, thread.owner_sub, token);
      return c.redirect(`${basePath}?done=${done}`, 303);
    });
  }

  return app;
}

/** The owner's pages, behind requireUser(). */
export const ownerThreadRoutes = threadRoutes('/plans/:id', async (c) => {
  const id = c.req.param('id') ?? '';
  if (!/^thr_[0-9a-f]{24}$/.test(id)) return null;
  const user = c.get('user');
  const thread = await getThread(c.env.DB, id, user.sub);
  return thread ? { thread, mode: 'owner', basePath: `/plans/${thread.id}`, user } : null;
});

/**
 * The pages of a share link, for anyone with the URL. A visitor who is
 * signed in posts under their name; others give a name in the forms.
 */
export const sharedThreadRoutes = threadRoutes('/s/:token', async (c) => {
  const thread = await getThreadByShareToken(c.env.DB, c.req.param('token') ?? '');
  if (!thread?.share_token) return null;
  const session = await currentSession(c, c.env.DB, c.get('config'));
  const user = session ? { sub: session.sub, name: session.name, email: session.email } : null;
  return { thread, mode: 'guest', basePath: `/s/${thread.share_token}`, user };
});
// Unknown paths under /s/ end here, not at the sign-in page.
sharedThreadRoutes.all('/s/*', (c) => notFound(c));
