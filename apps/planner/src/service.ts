/**
 * Starting routine runs and recording what they send back.
 *
 * A run is one fire of the routine for the latest user message of a thread.
 * Each run has its own token (the run token), sent in the fire and expected
 * back with the result in the X-Planner-Run-Token header next to the
 * routine's access token. Only its SHA-256 is stored, and it is accepted while
 * the run is active and not expired. The access token says the result comes
 * from the routine; the run token says which request it answers.
 */
import { randomToken, sha256Hex, timingSafeEqual } from './crypto.js';
import {
  completeRunWithMessage,
  countRunsSince,
  createRun,
  expireStaleRuns,
  findActiveRun,
  finishRun,
  getRun,
  getThreadById,
  listMessages,
  markRunFired,
  now,
  setRunProgress,
  setThreadStatus,
  toPayloadMessage,
  type MessageRow,
  type RunRow,
  type ThreadRow,
  type ThreadStatus,
} from './db.js';
import type { AppConfig } from './env.js';
import type { CurrentUser } from './auth/session.js';
import type { CallbackMessage } from './routine/callback.js';
import { fireRoutine } from './routine/fire.js';
import { buildRoutinePayload } from './routine/payload.js';

export const threadUrl = (config: AppConfig, threadId: string) => `${config.appOrigin}/plans/${threadId}`;

/**
 * Whether the user may start a run on this thread now: no run of the thread
 * is active, and the user is under the hourly limit. Returns the reason
 * when not.
 */
export async function runBlocker(
  db: D1Database,
  config: AppConfig,
  user: CurrentUser,
  threadId: string | null,
): Promise<string | null> {
  if (threadId) {
    await expireStaleRuns(db, threadId);
    if (await findActiveRun(db, threadId)) return 'このスレッドでは Claude Code が作業中です。結果が返るまでお待ちください。';
  }
  const recent = await countRunsSince(db, user.sub, now() - 3600);
  if (recent >= config.runsPerHourLimit) {
    return `1 時間あたりの依頼回数の上限（${config.runsPerHourLimit} 回）に達しました。しばらくしてから送ってください。`;
  }
  return null;
}

/** Fires the routine for the thread's latest user message. The run records the outcome either way. */
export async function startRun(
  db: D1Database,
  config: AppConfig,
  input: { thread: ThreadRow; triggerMessage: MessageRow; user: CurrentUser },
  fetchImpl: typeof fetch = fetch,
): Promise<RunRow> {
  const token = randomToken();
  const run = await createRun(db, {
    threadId: input.thread.id,
    ownerSub: input.user.sub,
    triggerMessageId: input.triggerMessage.id,
    callbackTokenHash: await sha256Hex(token),
    ttlSeconds: config.runTimeoutSeconds,
  });

  if (!config.routine) {
    await failRun(db, run, 'ルーチンが設定されていません。ROUTINE_FIRE_URL と ROUTINE_TOKEN を設定してください（/setup を参照）。');
    return run;
  }

  const messages = await listMessages(db, input.thread.id);
  const text = buildRoutinePayload({
    runId: run.id,
    runToken: token,
    thread: { title: input.thread.title, url: threadUrl(config, input.thread.id) },
    requester: { sub: input.user.sub, name: input.user.name },
    messages: messages.map(toPayloadMessage),
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
};

export async function recordCallback(
  db: D1Database,
  config: AppConfig,
  run: RunRow,
  message: CallbackMessage,
): Promise<CallbackOutcome> {
  if (message.kind === 'progress') {
    return (await setRunProgress(db, run.id, message.markdown))
      ? { status: 202 }
      : { status: 409, error: 'run_finished' };
  }
  const recorded = await completeRunWithMessage(db, {
    run,
    runStatus: message.kind === 'error' ? 'failed' : 'completed',
    threadStatus: THREAD_STATUS_BY_KIND[message.kind],
    kind: message.kind,
    ...(message.title ? { title: message.title } : {}),
    body: message.markdown,
    questions: message.questions,
    ...(message.kind === 'error' ? { error: 'Claude Code がエラーを返しました。' } : {}),
  });
  if (!recorded) return { status: 409, error: 'run_finished' };
  const thread = await getThreadById(db, run.thread_id);
  return { status: 201, messageId: recorded.id, threadUrl: threadUrl(config, thread?.id ?? run.thread_id) };
}
