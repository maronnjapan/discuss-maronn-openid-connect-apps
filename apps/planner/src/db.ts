/** Reads and writes the tables of migrations/0001_init.sql. */
import { newId } from './crypto.js';
import type { Question } from './routine/callback.js';
import type { MessageKind, PayloadMessage } from './routine/payload.js';

export const now = () => Math.floor(Date.now() / 1000);

export type ThreadStatus = 'running' | 'awaiting_answer' | 'plan_ready' | 'failed';
export type RunStatus = 'firing' | 'running' | 'completed' | 'failed' | 'expired';

export interface SessionRow {
  id_hash: string;
  sub: string;
  name: string | null;
  email: string | null;
  id_token: string | null;
  created_at: number;
  expires_at: number;
}

export interface LoginAttemptRow {
  state: string;
  code_verifier: string;
  nonce: string;
  return_to: string;
  expires_at: number;
}

export interface ThreadRow {
  id: string;
  owner_sub: string;
  owner_name: string | null;
  title: string;
  status: ThreadStatus;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: string;
  thread_id: string;
  seq: number;
  run_id: string | null;
  role: 'user' | 'assistant';
  kind: MessageKind;
  title: string | null;
  body: string;
  questions_json: string | null;
  created_at: number;
}

export interface RunRow {
  id: string;
  thread_id: string;
  owner_sub: string;
  trigger_message_id: string;
  status: RunStatus;
  callback_token_hash: string;
  session_id: string | null;
  session_url: string | null;
  progress_note: string | null;
  progress_at: number | null;
  error: string | null;
  created_at: number;
  completed_at: number | null;
  expires_at: number;
}

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['firing', 'running'];

export function messageQuestions(message: Pick<MessageRow, 'questions_json'>): Question[] {
  if (!message.questions_json) return [];
  try {
    return JSON.parse(message.questions_json) as Question[];
  } catch {
    return [];
  }
}

export function toPayloadMessage(message: MessageRow): PayloadMessage {
  const questions = messageQuestions(message);
  return {
    seq: message.seq,
    role: message.role,
    kind: message.kind,
    title: message.title,
    body: message.body,
    createdAt: message.created_at,
    ...(questions.length > 0 ? { questions } : {}),
  };
}

// ---------------------------------------------------------------------------
// Sessions and login attempts

export async function createSession(db: D1Database, row: SessionRow): Promise<void> {
  await db
    .prepare(
      'INSERT INTO sessions (id_hash, sub, name, email, id_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(row.id_hash, row.sub, row.name, row.email, row.id_token, row.created_at, row.expires_at)
    .run();
}

export async function findSession(db: D1Database, idHash: string): Promise<SessionRow | null> {
  return db.prepare('SELECT * FROM sessions WHERE id_hash = ? AND expires_at > ?').bind(idHash, now()).first<SessionRow>();
}

/** Deletes a session and returns it, so logout can still send its id_token_hint. */
export async function takeSession(db: D1Database, idHash: string): Promise<SessionRow | null> {
  return db.prepare('DELETE FROM sessions WHERE id_hash = ? RETURNING *').bind(idHash).first<SessionRow>();
}

export async function saveLoginAttempt(db: D1Database, row: LoginAttemptRow): Promise<void> {
  const created = now();
  await db.batch([
    db.prepare('DELETE FROM login_attempts WHERE expires_at <= ?').bind(created),
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(created),
    db
      .prepare(
        'INSERT INTO login_attempts (state, code_verifier, nonce, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(row.state, row.code_verifier, row.nonce, row.return_to, created, row.expires_at),
  ]);
}

/** A login attempt can be used once: it is deleted as it is read. */
export async function takeLoginAttempt(db: D1Database, state: string): Promise<LoginAttemptRow | null> {
  return db
    .prepare('DELETE FROM login_attempts WHERE state = ? AND expires_at > ? RETURNING *')
    .bind(state, now())
    .first<LoginAttemptRow>();
}

// ---------------------------------------------------------------------------
// Threads and messages

export async function createThread(
  db: D1Database,
  input: { ownerSub: string; ownerName: string | null; title: string },
): Promise<ThreadRow> {
  const created = now();
  const row: ThreadRow = {
    id: newId('thr'),
    owner_sub: input.ownerSub,
    owner_name: input.ownerName,
    title: input.title,
    status: 'running',
    created_at: created,
    updated_at: created,
  };
  await db
    .prepare('INSERT INTO threads (id, owner_sub, owner_name, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(row.id, row.owner_sub, row.owner_name, row.title, row.status, row.created_at, row.updated_at)
    .run();
  return row;
}

export async function listThreads(db: D1Database, ownerSub: string): Promise<ThreadRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM threads WHERE owner_sub = ? ORDER BY updated_at DESC LIMIT 200')
    .bind(ownerSub)
    .all<ThreadRow>();
  return results;
}

export async function getThread(db: D1Database, id: string, ownerSub: string): Promise<ThreadRow | null> {
  return db.prepare('SELECT * FROM threads WHERE id = ? AND owner_sub = ?').bind(id, ownerSub).first<ThreadRow>();
}

export async function getThreadById(db: D1Database, id: string): Promise<ThreadRow | null> {
  return db.prepare('SELECT * FROM threads WHERE id = ?').bind(id).first<ThreadRow>();
}

export async function setThreadStatus(db: D1Database, id: string, status: ThreadStatus): Promise<void> {
  await db.prepare('UPDATE threads SET status = ?, updated_at = ? WHERE id = ?').bind(status, now(), id).run();
}

export async function deleteThread(db: D1Database, id: string, ownerSub: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM threads WHERE id = ? AND owner_sub = ?').bind(id, ownerSub).run();
  return result.meta.changes > 0;
}

export async function addMessage(
  db: D1Database,
  input: {
    threadId: string;
    runId?: string | null;
    role: MessageRow['role'];
    kind: MessageKind;
    title?: string | null;
    body: string;
    questions?: Question[];
  },
): Promise<MessageRow> {
  const id = newId('msg');
  const created = now();
  const questionsJson = input.questions && input.questions.length > 0 ? JSON.stringify(input.questions) : null;
  // The sequence number is taken in the same statement as the insert, so two
  // messages of one thread never get the same number (UNIQUE (thread_id, seq)).
  const row = await db
    .prepare(
      'INSERT INTO messages (id, thread_id, seq, run_id, role, kind, title, body, questions_json, created_at) ' +
        'SELECT ?, ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, ?, ? FROM messages WHERE thread_id = ? RETURNING *',
    )
    .bind(
      id,
      input.threadId,
      input.runId ?? null,
      input.role,
      input.kind,
      input.title ?? null,
      input.body,
      questionsJson,
      created,
      input.threadId,
    )
    .first<MessageRow>();
  if (!row) throw new Error('Failed to insert the message');
  return row;
}

export async function listMessages(db: D1Database, threadId: string): Promise<MessageRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY seq')
    .bind(threadId)
    .all<MessageRow>();
  return results;
}

export async function getMessage(db: D1Database, threadId: string, id: string): Promise<MessageRow | null> {
  return db.prepare('SELECT * FROM messages WHERE thread_id = ? AND id = ?').bind(threadId, id).first<MessageRow>();
}

// ---------------------------------------------------------------------------
// Runs

export async function createRun(
  db: D1Database,
  input: { threadId: string; ownerSub: string; triggerMessageId: string; callbackTokenHash: string; ttlSeconds: number },
): Promise<RunRow> {
  const created = now();
  const row: RunRow = {
    id: newId('run'),
    thread_id: input.threadId,
    owner_sub: input.ownerSub,
    trigger_message_id: input.triggerMessageId,
    status: 'firing',
    callback_token_hash: input.callbackTokenHash,
    session_id: null,
    session_url: null,
    progress_note: null,
    progress_at: null,
    error: null,
    created_at: created,
    completed_at: null,
    expires_at: created + input.ttlSeconds,
  };
  await db
    .prepare(
      'INSERT INTO runs (id, thread_id, owner_sub, trigger_message_id, status, callback_token_hash, created_at, expires_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(row.id, row.thread_id, row.owner_sub, row.trigger_message_id, row.status, row.callback_token_hash, row.created_at, row.expires_at)
    .run();
  return row;
}

export async function getRun(db: D1Database, id: string): Promise<RunRow | null> {
  return db.prepare('SELECT * FROM runs WHERE id = ?').bind(id).first<RunRow>();
}

export async function listRuns(db: D1Database, threadId: string): Promise<RunRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM runs WHERE thread_id = ? ORDER BY created_at')
    .bind(threadId)
    .all<RunRow>();
  return results;
}

export async function findActiveRun(db: D1Database, threadId: string): Promise<RunRow | null> {
  return db
    .prepare("SELECT * FROM runs WHERE thread_id = ? AND status IN ('firing', 'running') ORDER BY created_at DESC LIMIT 1")
    .bind(threadId)
    .first<RunRow>();
}

export async function countRunsSince(db: D1Database, ownerSub: string, since: number): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS count FROM runs WHERE owner_sub = ? AND created_at >= ?')
    .bind(ownerSub, since)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

/** Records the session of a fire. A run that already finished (a fast callback) keeps its status. */
export async function markRunFired(db: D1Database, id: string, sessionId: string, sessionUrl: string): Promise<void> {
  await db
    .prepare("UPDATE runs SET session_id = ?, session_url = ?, status = CASE WHEN status = 'firing' THEN 'running' ELSE status END WHERE id = ?")
    .bind(sessionId, sessionUrl, id)
    .run();
}

/**
 * Ends an active run. Only one of several concurrent callers wins: the
 * update applies only while the run is still active.
 */
export async function finishRun(
  db: D1Database,
  id: string,
  status: Exclude<RunStatus, 'firing' | 'running'>,
  error?: string,
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE runs SET status = ?, error = ?, completed_at = ? WHERE id = ? AND status IN ('firing', 'running')")
    .bind(status, error ?? null, now(), id)
    .run();
  return result.meta.changes > 0;
}

/**
 * Records the result of a run in one transaction (a D1 batch): the
 * assistant's message, the end of the run and the thread's new status. The
 * message is inserted only while the run is active, so of two callbacks for
 * the same run only the first one is recorded. Returns the message, or null
 * when the run was no longer active.
 */
export async function completeRunWithMessage(
  db: D1Database,
  input: {
    run: Pick<RunRow, 'id' | 'thread_id'>;
    runStatus: 'completed' | 'failed';
    threadStatus: ThreadStatus;
    kind: MessageKind;
    title?: string;
    body: string;
    questions: Question[];
    error?: string;
  },
): Promise<MessageRow | null> {
  const id = newId('msg');
  const created = now();
  const questionsJson = input.questions.length > 0 ? JSON.stringify(input.questions) : null;
  const active = "EXISTS (SELECT 1 FROM runs WHERE id = ? AND status IN ('firing', 'running'))";
  const [inserted] = await db.batch<MessageRow>([
    db
      .prepare(
        'INSERT INTO messages (id, thread_id, seq, run_id, role, kind, title, body, questions_json, created_at) ' +
          "SELECT ?, ?, COALESCE((SELECT MAX(seq) FROM messages WHERE thread_id = ?), 0) + 1, ?, 'assistant', ?, ?, ?, ?, ? " +
          `WHERE ${active} RETURNING *`,
      )
      .bind(id, input.run.thread_id, input.run.thread_id, input.run.id, input.kind, input.title ?? null, input.body, questionsJson, created, input.run.id),
    db
      .prepare('UPDATE threads SET status = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM messages WHERE id = ?)')
      .bind(input.threadStatus, created, input.run.thread_id, id),
    db
      .prepare("UPDATE runs SET status = ?, error = ?, completed_at = ? WHERE id = ? AND status IN ('firing', 'running')")
      .bind(input.runStatus, input.error ?? null, created, input.run.id),
  ]);
  return inserted?.results[0] ?? null;
}

export async function setRunProgress(db: D1Database, id: string, note: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE runs SET progress_note = ?, progress_at = ? WHERE id = ? AND status IN ('firing', 'running')")
    .bind(note, now(), id)
    .run();
  return result.meta.changes > 0;
}

/** Marks the active runs of a thread whose callback never came as expired. */
export async function expireStaleRuns(db: D1Database, threadId: string): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE runs SET status = 'expired', error = ?, completed_at = ? WHERE thread_id = ? AND status IN ('firing', 'running') AND expires_at <= ?",
    )
    .bind('Claude Code から結果が返ってこないまま、待ち時間の上限を過ぎました。', now(), threadId, now())
    .run();
  return result.meta.changes > 0;
}
