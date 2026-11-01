/**
 * Starting routine runs and recording what they send back.
 *
 * A run is one fire of the routine for the latest user message of a thread:
 * a request or a reply (task "plan"), or a request for an implementation
 * prompt (task "implementation_prompt").
 * Each run has its own token (the run token), sent in the fire and expected
 * back with the result in the X-Planner-Run-Token header next to the
 * routine's access token. Only its SHA-256 is stored, and it is accepted while
 * the run is active and not expired. The access token says the result comes
 * from the routine; the run token says which request it answers.
 */
import { randomToken, sha256Hex, timingSafeEqual } from './crypto.js';
import {
  authorLabel,
  completeRunWithMessage,
  countRunsSince,
  createRun,
  expireStaleRuns,
  findActiveRun,
  finishRun,
  getRun,
  getThreadById,
  listComments,
  listMessages,
  markRunFired,
  now,
  setRunProgress,
  setThreadStatus,
  toPayloadComments,
  toPayloadMessages,
  type Author,
  type MessageRow,
  type RunRow,
  type ThreadRow,
  type ThreadStatus,
} from './db.js';
import type { AppConfig } from './env.js';
import { CALLBACK_KINDS_BY_TASK, type CallbackMessage } from './routine/callback.js';
import { fireRoutine } from './routine/fire.js';
import { buildRoutinePayload, type RunTask } from './routine/payload.js';

export const threadUrl = (config: AppConfig, threadId: string) => `${config.appOrigin}/plans/${threadId}`;

/**
 * Whether a run may start on this thread now: no run of the thread is
 * active, and the thread's owner is under the hourly limit (runs started by
 * visitors of a share link count against the owner too). Returns the reason
 * when not.
 */
export async function runBlocker(
  db: D1Database,
  config: AppConfig,
  ownerSub: string,
  threadId: string | null,
): Promise<string | null> {
  if (threadId) {
    await expireStaleRuns(db, threadId);
    if (await findActiveRun(db, threadId)) return 'このスレッドでは Claude Code が作業中です。結果が返るまでお待ちください。';
  }
  const recent = await countRunsSince(db, ownerSub, now() - 3600);
  if (recent >= config.runsPerHourLimit) {
    return `1 時間あたりの依頼回数の上限（${config.runsPerHourLimit} 回）に達しました。しばらくしてから送ってください。`;
  }
  return null;
}

/** The task of a run started for a message: a request for an implementation prompt, or work on the plan. */
export const taskFor = (message: Pick<MessageRow, 'kind'>): RunTask =>
  message.kind === 'prompt_request' ? 'implementation_prompt' : 'plan';

/** Fires the routine for the thread's latest user message. The run records the outcome either way. */
export async function startRun(
  db: D1Database,
  config: AppConfig,
  input: { thread: ThreadRow; triggerMessage: MessageRow; requester: Author },
  fetchImpl: typeof fetch = fetch,
): Promise<RunRow> {
  const token = randomToken();
  const run = await createRun(db, {
    threadId: input.thread.id,
    ownerSub: input.thread.owner_sub,
    task: taskFor(input.triggerMessage),
    triggerMessageId: input.triggerMessage.id,
    callbackTokenHash: await sha256Hex(token),
    ttlSeconds: config.runTimeoutSeconds,
  });

  if (!config.routine) {
    await failRun(db, run, 'ルーチンが設定されていません。ROUTINE_FIRE_URL と ROUTINE_TOKEN を設定してください（/setup を参照）。');
    return run;
  }

  const [messages, comments] = await Promise.all([listMessages(db, input.thread.id), listComments(db, input.thread.id)]);
  const text = buildRoutinePayload({
    task: run.task,
    runId: run.id,
    runToken: token,
    thread: { title: input.thread.title, url: threadUrl(config, input.thread.id) },
    requester: { sub: input.requester.sub, name: authorLabel({ author_sub: input.requester.sub, author_name: input.requester.name }) },
    messages: toPayloadMessages(messages),
    comments: toPayloadComments(comments, messages),
  });

  const result = await fireRoutine(config.routine, text, fetchImpl);
  if (result.ok) {
    await markRunFired(db, run.id, result.sessionId, result.sessionUrl);
    await setThreadStatus(db, input.thread.id, 'running');
  } else {
    console.warn(`[planner] fire failed for ${run.id}: ${result.status} ${result.errorType}`);
    await failRun(db, run, result.message);
  }
  return run;
}

async function failRun(db: D1Database, run: RunRow, error: string): Promise<void> {
  await finishRun(db, run.id, 'failed', error);
  await setThreadStatus(db, run.thread_id, 'failed');
}

export type CallbackOutcome =
  | { status: 201; messageId: string; threadUrl: string }
  | { status: 202 }
  | { status: 400; error: 'invalid_request'; description: string }
  | { status: 401 | 404 | 409 | 410; error: string };

/** Checks a callback's run token against the run (after its access token was verified). */
export async function authorizeCallback(
  db: D1Database,
  runId: string,
  runToken: string | undefined,
): Promise<{ ok: true; run: RunRow } | { ok: false; status: 401 | 404 | 409 | 410; error: string }> {
  const token = runToken?.trim();
  const run = /^run_[0-9a-f]{24}$/.test(runId) ? await getRun(db, runId) : null;
  // The same answer for an unknown run and a wrong token, so run ids cannot be probed.
  if (!token || !run || !timingSafeEqual(await sha256Hex(token), run.callback_token_hash)) {
    return { ok: false, status: 401, error: 'invalid_run_token' };
  }
  if (run.status === 'firing' || run.status === 'running') {
    if (run.expires_at <= now()) {
      await expireStaleRuns(db, run.thread_id);
      await setThreadStatus(db, run.thread_id, 'failed');
      return { ok: false, status: 410, error: 'run_expired' };
    }
    return { ok: true, run };
  }
  return { ok: false, status: run.status === 'expired' ? 410 : 409, error: `run_${run.status}` };
}

const THREAD_STATUS_BY_KIND: Record<Exclude<CallbackMessage['kind'], 'progress'>, ThreadStatus> = {
  plan: 'plan_ready',
  questions: 'awaiting_answer',
  error: 'failed',
  // The plan stays as it was; the prompt is made from it.
  implementation_prompt: 'plan_ready',
};

export async function recordCallback(
  db: D1Database,
  config: AppConfig,
  run: RunRow,
  message: CallbackMessage,
): Promise<CallbackOutcome> {
  const allowed: readonly string[] = CALLBACK_KINDS_BY_TASK[run.task];
  if (!allowed.includes(message.kind)) {
    return {
      status: 400,
      error: 'invalid_request',
      description: `"kind" must be one of ${allowed.join(', ')} for this run (task "${run.task}").`,
    };
  }
  if (message.kind === 'progress') {
    return (await setRunProgress(db, run.id, message.markdown))
      ? { status: 202 }
      : { status: 409, error: 'run_finished' };
  }
  const changeSummary = message.kind === 'plan' ? message.changes : message.kind === 'implementation_prompt' ? message.notes : undefined;
  const recorded = await completeRunWithMessage(db, {
    run,
    runStatus: message.kind === 'error' ? 'failed' : 'completed',
    threadStatus: THREAD_STATUS_BY_KIND[message.kind],
    kind: message.kind,
    ...(message.title ? { title: message.title } : {}),
    body: message.markdown,
    questions: message.questions,
    ...(changeSummary ? { changeSummary } : {}),
    commentReplies: message.commentReplies,
    ...(message.kind === 'error' ? { error: 'Claude Code がエラーを返しました。' } : {}),
  });
  if (!recorded) return { status: 409, error: 'run_finished' };
  const thread = await getThreadById(db, run.thread_id);
  return { status: 201, messageId: recorded.id, threadUrl: threadUrl(config, thread?.id ?? run.thread_id) };
}
