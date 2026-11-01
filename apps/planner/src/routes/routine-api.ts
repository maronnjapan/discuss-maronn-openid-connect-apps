/**
 * The endpoints the routine calls from its Claude Code session:
 *
 *   GET  /api/routine/ping                   whether the bearer token arrives (no run)
 *   POST /api/routine/runs/{runId}/messages  the plan, questions, progress or error
 *   GET  /api/routine/runs/{runId}/context   the whole conversation as Markdown
 *
 * The requests of a run carry two credentials:
 * - Authorization: Bearer <token>, the routine's shared token
 *   (src/auth/routine-token.ts). The agent proxy of the routine's environment
 *   adds it (the network secret of src/routine/prompt.ts), so it shows that
 *   the request comes from that environment.
 * - X-Planner-Run-Token: <run token>, the token of the run, from the fire
 */
import { Hono, type Context } from 'hono';
import { RoutineTokenError, verifyRoutineToken } from '../auth/routine-token.js';
import type { AppVariables } from '../auth/session.js';
import { getThreadById, listMessages, toPayloadMessage } from '../db.js';
import type { Bindings } from '../env.js';
import { LIMITS, parseCallbackBody } from '../routine/callback.js';
import { renderConversation } from '../routine/payload.js';
import { PING_PATH, RUN_TOKEN_HEADER } from '../routine/prompt.js';
import { authorizeCallback, recordCallback } from '../service.js';

export const routineApi = new Hono<{ Bindings: Bindings; Variables: AppVariables }>();

const ERROR_DESCRIPTIONS: Record<string, string> = {
  invalid_run_token: `The ${RUN_TOKEN_HEADER} header does not match this run.`,
  run_expired: 'This run timed out; the result is no longer accepted.',
  run_completed: 'This run already has its result.',
  run_failed: 'This run has already failed.',
  run_finished: 'This run already has its result.',
};

/** The bearer token check shared by both endpoints; a Response when it fails. */
async function rejectBearerToken(c: Context<{ Bindings: Bindings; Variables: AppVariables }>): Promise<Response | null> {
  try {
    await verifyRoutineToken(c.get('config'), c.req.raw);
    return null;
  } catch (error) {
    if (!(error instanceof RoutineTokenError)) throw error;
    return c.json({ error: error.error, error_description: error.description }, error.status, {
      'WWW-Authenticate': error.wwwAuthenticate,
    });
  }
}

/**
 * The check of the network secret: the routine calls it before it starts
 * work, and alone when it runs without a request ("Run now" with no text).
 * It answers only whether the token is right.
 */
routineApi.get(PING_PATH, async (c) => {
  try {
    await verifyRoutineToken(c.get('config'), c.req.raw);
    return c.json({ ok: true }, 200, { 'Cache-Control': 'no-store' });
  } catch (error) {
    if (!(error instanceof RoutineTokenError)) throw error;
    return c.json({ ok: false, error: error.error, error_description: error.description }, error.status, {
      'WWW-Authenticate': error.wwwAuthenticate,
      'Cache-Control': 'no-store',
    });
  }
});

routineApi.post('/api/routine/runs/:runId/messages', async (c) => {
  const rejected = await rejectBearerToken(c);
  if (rejected) return rejected;
  const runId = c.req.param('runId');
  const auth = await authorizeCallback(c.env.DB, runId, c.req.header(RUN_TOKEN_HEADER));
  if (!auth.ok) {
    return c.json({ error: auth.error, error_description: ERROR_DESCRIPTIONS[auth.error] ?? auth.error }, auth.status);
  }

  const declaredLength = Number(c.req.header('Content-Length') ?? '0');
  if (declaredLength > LIMITS.bodyBytes) {
    return c.json({ error: 'payload_too_large', error_description: `The body must be at most ${LIMITS.bodyBytes} bytes.` }, 413);
  }
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).length > LIMITS.bodyBytes) {
    return c.json({ error: 'payload_too_large', error_description: `The body must be at most ${LIMITS.bodyBytes} bytes.` }, 413);
  }

  const parsed = parseCallbackBody(c.req.header('Content-Type') ?? '', raw, new URL(c.req.url).searchParams);
  if (!parsed.ok) return c.json({ error: 'invalid_request', error_description: parsed.error }, 400);

  const outcome = await recordCallback(c.env.DB, c.get('config'), auth.run, parsed.message);
  switch (outcome.status) {
    case 201:
      return c.json({ ok: true, message_id: outcome.messageId, thread_url: outcome.threadUrl }, 201);
    case 202:
      return c.json({ ok: true }, 202);
    default:
      return c.json({ error: outcome.error, error_description: ERROR_DESCRIPTIONS[outcome.error] ?? outcome.error }, outcome.status);
  }
});

routineApi.get('/api/routine/runs/:runId/context', async (c) => {
  const rejected = await rejectBearerToken(c);
  if (rejected) return rejected;
  const auth = await authorizeCallback(c.env.DB, c.req.param('runId'), c.req.header(RUN_TOKEN_HEADER));
  if (!auth.ok) {
    return c.json({ error: auth.error, error_description: ERROR_DESCRIPTIONS[auth.error] ?? auth.error }, auth.status);
  }
  const thread = await getThreadById(c.env.DB, auth.run.thread_id);
  const messages = await listMessages(c.env.DB, auth.run.thread_id);
  return c.body(renderConversation({ title: thread?.title ?? '' }, messages.map(toPayloadMessage)), 200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Cache-Control': 'no-store',
  });
});
