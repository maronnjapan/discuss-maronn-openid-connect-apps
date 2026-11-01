/** @jsxImportSource hono/jsx */
/** The pages of the signed-in user: the plans, a thread, replies, and the setup guide. */
import { Hono, type Context } from 'hono';
import type { AppVariables, CurrentUser } from '../auth/session.js';
import {
  addMessage,
  deleteThread,
  expireStaleRuns,
  getMessage,
  getThread,
  listMessages,
  listRuns,
  listThreads,
  messageQuestions,
  setThreadStatus,
  createThread,
  ACTIVE_RUN_STATUSES,
  type MessageRow,
  type RunRow,
  type ThreadRow,
} from '../db.js';
import type { AppConfig, Bindings } from '../env.js';
import { renderMarkdown } from '../markdown.js';
import type { Question } from '../routine/callback.js';
import { routineAllowedDomains, routineNetworkSecret, routinePrompt } from '../routine/prompt.js';
import { runBlocker, startRun } from '../service.js';
import {
  DashboardPage,
  ErrorPage,
  NewPlanPage,
  SetupPage,
  ThreadPage,
  type NewPlanValues,
  type TimelineItem,
} from '../views/pages.js';

type AppEnv = { Bindings: Bindings; Variables: AppVariables };
type AppContext = Context<AppEnv>;

export const planRoutes = new Hono<AppEnv>();

const LIMITS = { title: 120, feature: 20_000, specs: 500, notes: 10_000, message: 20_000, answer: 10_000 } as const;

function formString(form: Record<string, unknown>, name: string): string {
  const value = form[name];
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
}

// ---------------------------------------------------------------------------
// Thread view

interface ThreadView {
  items: TimelineItem[];
  runs: RunRow[];
  activeRun: RunRow | null;
  latestRun: RunRow | null;
  pendingQuestions: TimelineItem | null;
  latestPlan: TimelineItem | null;
  progressHtml: string | null;
  signature: string;
}

async function loadThreadView(db: D1Database, thread: ThreadRow): Promise<ThreadView> {
  if (await expireStaleRuns(db, thread.id)) {
    await setThreadStatus(db, thread.id, 'failed');
    thread.status = 'failed';
  }
  const [messages, runs] = await Promise.all([listMessages(db, thread.id), listRuns(db, thread.id)]);
  const latestRunByMessage = new Map<string, RunRow>();
  for (const run of runs) latestRunByMessage.set(run.trigger_message_id, run);

  let planVersion = 0;
  const items: TimelineItem[] = messages.map((message) => {
    const rendered = renderMarkdown(message.body, { idPrefix: message.id });
    const run = latestRunByMessage.get(message.id);
    return {
      message,
      html: rendered.html,
      headings: rendered.headings,
      questions: messageQuestions(message),
      ...(run ? { run } : {}),
      ...(message.kind === 'plan' ? { planVersion: ++planVersion } : {}),
    };
  });

  const activeRun = [...runs].reverse().find((run) => ACTIVE_RUN_STATUSES.includes(run.status)) ?? null;
  const last = items[items.length - 1];
  return {
    items,
    runs,
    activeRun,
    latestRun: runs[runs.length - 1] ?? null,
    pendingQuestions: last && last.message.kind === 'questions' ? last : null,
    latestPlan: [...items].reverse().find((item) => item.message.kind === 'plan') ?? null,
    progressHtml: activeRun?.progress_note ? renderMarkdown(activeRun.progress_note, { idPrefix: 'progress' }).html : null,
    signature: `${activeRun?.status ?? 'idle'}:${messages.length}:${activeRun?.progress_at ?? 0}`,
  };
}

async function renderThread(c: AppContext, thread: ThreadRow, extra: { error?: string | null; notice?: string | null } = {}, status: 200 | 400 | 409 | 429 = 200) {
  const view = await loadThreadView(c.env.DB, thread);
  return c.html(
    <ThreadPage
      user={c.get('user')}
      thread={thread}
      items={view.items}
      activeRun={view.activeRun}
      latestRun={view.latestRun}
      pendingQuestions={view.pendingQuestions}
      latestPlan={view.latestPlan}
      progressHtml={view.progressHtml}
      pollSignature={view.signature}
      error={extra.error ?? null}
      notice={extra.notice ?? null}
    />,
    status,
  );
}

async function ownThread(c: AppContext): Promise<ThreadRow | null> {
  return getThread(c.env.DB, c.req.param('id') ?? '', c.get('user').sub);
}

function notFound(c: AppContext) {
  return c.html(<ErrorPage title="見つかりません" message="指定された計画は存在しないか、閲覧できません。" user={c.get('user')} />, 404);
}

// ---------------------------------------------------------------------------
// Composing user messages

export function composeRequest(values: NewPlanValues): string {
  const sections = [`## 作りたい機能\n\n${values.feature}`];
  if (values.specs) sections.push(`## 関連する仕様\n\n${values.specs}`);
  if (values.notes) sections.push(`## 前提・制約・補足\n\n${values.notes}`);
  return sections.join('\n\n');
}

/** Turns the answer form into one Markdown message: each question, its choice and its answer. */
export function composeReply(questions: Question[], form: Record<string, unknown>): string | null {
  const parts: string[] = [];
  let answered = false;
  if (questions.length > 0) {
    const answers = questions.map((question) => {
      const choice = formString(form, `choice.${question.id}`).slice(0, LIMITS.answer);
      const answer = formString(form, `answer.${question.id}`).slice(0, LIMITS.answer);
      if (choice || answer) answered = true;
      const lines = [`### ${question.id}. ${question.question.replace(/\s*\n\s*/g, ' ')}`];
      if (choice) lines.push(`**選択:** ${choice}`);
      if (answer) lines.push(answer);
      if (!choice && !answer) lines.push('（回答なし。判断は任せる）');
      return lines.join('\n\n');
    });
    parts.push(`## 質問への回答\n\n${answers.join('\n\n')}`);
  }
  const message = formString(form, 'message').slice(0, LIMITS.message);
  if (message) {
    answered = true;
    parts.push(questions.length > 0 ? `## ほかに伝えること\n\n${message}` : message);
  }
  return answered ? parts.join('\n\n') : null;
}

// ---------------------------------------------------------------------------
// Pages

planRoutes.get('/', async (c) => {
  const threads = await listThreads(c.env.DB, c.get('user').sub);
  return c.html(<DashboardPage user={c.get('user')} threads={threads} routineConfigured={c.get('config').routine !== null} />);
});

planRoutes.get('/plans/new', (c) => c.html(<NewPlanPage user={c.get('user')} />));

planRoutes.post('/plans', async (c) => {
  const user = c.get('user');
  const config = c.get('config');
  const form = await c.req.parseBody();
  const values: NewPlanValues = {
    title: formString(form, 'title').replace(/\s+/g, ' '),
    feature: formString(form, 'feature'),
    specs: formString(form, 'specs'),
    notes: formString(form, 'notes'),
  };
  const invalid =
    !values.title || !values.feature
      ? '機能の名前と、作りたい機能の説明を入力してください。'
      : values.title.length > LIMITS.title ||
          values.feature.length > LIMITS.feature ||
          values.specs.length > LIMITS.specs ||
          values.notes.length > LIMITS.notes
        ? '入力が長すぎます。'
        : null;
  if (invalid) return c.html(<NewPlanPage user={user} values={values} error={invalid} />, 400);

  const blocker = await runBlocker(c.env.DB, config, user, null);
  if (blocker) return c.html(<NewPlanPage user={user} values={values} error={blocker} />, 429);

  const thread = await createThread(c.env.DB, { ownerSub: user.sub, ownerName: user.name, title: values.title });
  const message = await addMessage(c.env.DB, {
    threadId: thread.id,
    role: 'user',
    kind: 'request',
    title: values.title,
    body: composeRequest(values),
  });
  await startRun(c.env.DB, config, { thread, triggerMessage: message, user });
  return c.redirect(`/plans/${thread.id}`, 303);
});

planRoutes.get('/plans/:id', async (c) => {
  const thread = await ownThread(c);
  if (!thread) return notFound(c);
  return renderThread(c, thread);
});

/** Polled by public/assets/app.js while a run is active. */
planRoutes.get('/plans/:id/status', async (c) => {
  const thread = await ownThread(c);
  if (!thread) return c.json({ error: 'not_found' }, 404);
  const view = await loadThreadView(c.env.DB, thread);
  return c.json(
    { status: thread.status, running: view.activeRun !== null, signature: view.signature },
    200,
    { 'Cache-Control': 'no-store' },
  );
});

planRoutes.post('/plans/:id/messages', async (c) => {
  const user = c.get('user');
  const config = c.get('config');
  const thread = await ownThread(c);
  if (!thread) return notFound(c);

  const blocker = await runBlocker(c.env.DB, config, user, thread.id);
  if (blocker) return renderThread(c, thread, { error: blocker }, 409);

  const messages = await listMessages(c.env.DB, thread.id);
  const last = messages[messages.length - 1];
  const questions = last?.kind === 'questions' ? messageQuestions(last) : [];
  const body = composeReply(questions, await c.req.parseBody());
  if (!body) return renderThread(c, thread, { error: '回答かメッセージを入力してください。' }, 400);

  const message = await addMessage(c.env.DB, { threadId: thread.id, role: 'user', kind: 'reply', body });
  await startRun(c.env.DB, config, { thread, triggerMessage: message, user });
  return c.redirect(`/plans/${thread.id}#${message.id}`, 303);
});

/** Fires the routine again for the latest user message, after a failed or expired run. */
planRoutes.post('/plans/:id/retry', async (c) => {
  const user = c.get('user');
  const config = c.get('config');
  const thread = await ownThread(c);
  if (!thread) return notFound(c);

  const blocker = await runBlocker(c.env.DB, config, user, thread.id);
  if (blocker) return renderThread(c, thread, { error: blocker }, 409);

  // The latest user message is the one to retry, also when Claude Code answered
  // it with an error message (that message stays in the history it receives).
  const messages = await listMessages(c.env.DB, thread.id);
  const runs = await listRuns(c.env.DB, thread.id);
  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');
  const latestRun = runs[runs.length - 1];
  const retryable =
    latestUserMessage &&
    latestRun?.trigger_message_id === latestUserMessage.id &&
    (latestRun.status === 'failed' || latestRun.status === 'expired');
  if (!retryable) {
    return renderThread(c, thread, { error: '再実行できる依頼がありません。' }, 400);
  }
  await startRun(c.env.DB, config, { thread, triggerMessage: latestUserMessage, user });
  return c.redirect(`/plans/${thread.id}`, 303);
});

planRoutes.post('/plans/:id/delete', async (c) => {
  await deleteThread(c.env.DB, c.req.param('id'), c.get('user').sub);
  return c.redirect('/', 303);
});

function markdownResponse(c: AppContext, body: string, filename: string, disposition: 'inline' | 'attachment') {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return c.body(body.endsWith('\n') ? body : `${body}\n`, 200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Disposition': `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
  });
}

planRoutes.get('/plans/:id/plan.md', async (c) => {
  const thread = await ownThread(c);
  if (!thread) return notFound(c);
  const messages = await listMessages(c.env.DB, thread.id);
  const plan = [...messages].reverse().find((message) => message.kind === 'plan');
  if (!plan) return notFound(c);
  return markdownResponse(c, plan.body, `${thread.title}.md`, 'attachment');
});

planRoutes.get('/plans/:id/messages/:file', async (c) => {
  const thread = await ownThread(c);
  const file = c.req.param('file');
  if (!thread || !file.endsWith('.md')) return notFound(c);
  const message: MessageRow | null = await getMessage(c.env.DB, thread.id, file.slice(0, -3));
  if (!message) return notFound(c);
  return markdownResponse(c, message.body, `${thread.title}-${message.seq}.md`, 'inline');
});

/** The preview tab of the Markdown fields: the same renderer as the thread page. */
planRoutes.post('/api/preview', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { markdown?: unknown };
  const markdown = typeof body.markdown === 'string' ? body.markdown.slice(0, 50_000) : '';
  return c.json({ html: renderMarkdown(markdown, { idPrefix: 'preview' }).html });
});

planRoutes.get('/setup', (c) => {
  const config: AppConfig = c.get('config');
  const prompt = routinePrompt({ appOrigin: config.appOrigin });
  const secret = routineNetworkSecret({ appOrigin: config.appOrigin });
  const user: CurrentUser = c.get('user');
  return c.html(
    <SetupPage
      user={user}
      prompt={prompt}
      promptHtml={renderMarkdown(prompt, { idPrefix: 'prompt' }).html}
      status={{
        appOrigin: config.appOrigin,
        issuer: config.issuer,
        clientId: config.clientId,
        routineConfigured: config.routine !== null,
        routineFireUrl: config.routine?.fireUrl ?? null,
        runsPerHourLimit: config.runsPerHourLimit,
        runTimeoutMinutes: Math.round(config.runTimeoutSeconds / 60),
        allowedSubs: config.allowedSubs,
        routineBearerTokenConfigured: config.routineBearerTokenHash !== null,
        allowedDomains: routineAllowedDomains(config.appOrigin),
        networkSecret: secret,
      }}
    />,
  );
});
