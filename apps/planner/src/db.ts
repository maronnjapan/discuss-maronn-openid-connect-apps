/** Reads and writes the tables of migrations/ (0001_init.sql, 0002_versions_comments_sharing.sql, 0003_comment_anchors.sql). */
import { newId } from './crypto.js';
import { blockExcerpt, planBlocks, type PlanBlock } from './markdown.js';
import type { CommentReply, Question } from './routine/callback.js';
import type { MessageKind, PayloadComment, PayloadMessage, RunTask } from './routine/payload.js';

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
  /** The token of the share link (/s/{token}); null while the thread is not shared. */
  share_token: string | null;
  shared_at: number | null;
}

/** A thread on the list of plans, with what the list shows besides its status. */
export interface ThreadSummaryRow extends ThreadRow {
  open_comments: number;
  has_prompt: number;
}

/** Who wrote a message or a comment: a signed-in user, or a visitor of a share link (no sub). */
export interface Author {
  sub: string | null;
  name: string | null;
}

export interface MessageRow {
  id: string;
  thread_id: string;
  seq: number;
  run_id: string | null;
  /** A plan with role user is a version people edited. */
  role: 'user' | 'assistant';
  kind: MessageKind;
  title: string | null;
  body: string;
  questions_json: string | null;
  author_sub: string | null;
  author_name: string | null;
  /** Plans: what changed and why. Implementation prompts: the notes of the formatting. */
  change_summary: string | null;
  /** The plan version (message id) the message builds on. */
  base_message_id: string | null;
  created_at: number;
}

export interface CommentRow {
  id: string;
  thread_id: string;
  /** The plan version the comment is on. */
  message_id: string;
  /** The level-2 heading the comment is under. */
  section: string | null;
  /** The line of the version's Markdown where the block the comment is on starts; null: the whole plan. */
  anchor_line: number | null;
  /** The text people selected to comment on. */
  quote: string | null;
  body: string;
  author_sub: string | null;
  author_name: string | null;
  created_at: number;
  resolved_at: number | null;
  resolved_by: 'user' | 'assistant' | null;
  resolved_by_name: string | null;
  reply: string | null;
  reply_run_id: string | null;
  reply_at: number | null;
}

export interface RunRow {
  id: string;
  thread_id: string;
  /** The owner of the thread, whose hourly limit the run counts against (also when a visitor of a share link started it). */
  owner_sub: string;
  task: RunTask;
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

/** How a writer is shown: the name, marked as a guest for a visitor of a share link (who signs in nowhere). */
export function authorLabel(author: { author_sub: string | null; author_name: string | null }): string {
  if (author.author_sub === null) return author.author_name ? `${author.author_name}（ゲスト）` : 'ゲスト';
  return author.author_name || author.author_sub;
}

/** The plan versions of a thread by message id: 1 for the first plan, 2 for the next, and so on. */
export function planVersionsById(messages: readonly Pick<MessageRow, 'id' | 'kind'>[]): Map<string, number> {
  const versions = new Map<string, number>();
  for (const message of messages) if (message.kind === 'plan') versions.set(message.id, versions.size + 1);
  return versions;
}

export function toPayloadMessages(messages: readonly MessageRow[]): PayloadMessage[] {
  const versions = planVersionsById(messages);
  return messages.map((message) => {
    const questions = messageQuestions(message);
    const basePlanVersion = message.base_message_id ? versions.get(message.base_message_id) : undefined;
    return {
      seq: message.seq,
      role: message.role,
      kind: message.kind,
      title: message.title,
      body: message.body,
      createdAt: message.created_at,
      ...(message.role === 'user' ? { author: authorLabel(message) } : {}),
      ...(message.change_summary ? { changeSummary: message.change_summary } : {}),
      ...((message.kind === 'prompt_request' || message.kind === 'implementation_prompt') && basePlanVersion
        ? { basePlanVersion }
        : {}),
      ...(questions.length > 0 ? { questions } : {}),
    };
  });
}

/**
 * The open comments of a thread, as the routine receives them. A comment on a
 * block carries the block's line and the start of its Markdown, so the
 * routine knows the place without reading that version.
 */
export function toPayloadComments(comments: readonly CommentRow[], messages: readonly MessageRow[]): PayloadComment[] {
  const versions = planVersionsById(messages);
  const bodies = new Map(messages.map((message) => [message.id, message.body]));
  const blocksOf = new Map<string, PlanBlock[]>();
  const blockOf = (comment: CommentRow) => {
    const body = bodies.get(comment.message_id);
    if (comment.anchor_line === null || body === undefined) return null;
    if (!blocksOf.has(comment.message_id)) blocksOf.set(comment.message_id, planBlocks(body));
    const block = blocksOf.get(comment.message_id)!.find((candidate) => candidate.line === comment.anchor_line);
    return block ? { line: block.line, excerpt: blockExcerpt(body, block) } : null;
  };
  return comments
    .filter((comment) => comment.resolved_at === null)
    .map((comment) => {
      const block = blockOf(comment);
      return {
        id: comment.id,
        planVersion: versions.get(comment.message_id) ?? 0,
        section: comment.section,
        ...(block ? { line: block.line, excerpt: block.excerpt } : {}),
        quote: comment.quote,
        body: comment.body,
        author: authorLabel(comment),
        createdAt: comment.created_at,
      };
    });
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
    share_token: null,
    shared_at: null,
  };
  await db
    .prepare('INSERT INTO threads (id, owner_sub, owner_name, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(row.id, row.owner_sub, row.owner_name, row.title, row.status, row.created_at, row.updated_at)
    .run();
  return row;
}

export async function listThreads(db: D1Database, ownerSub: string): Promise<ThreadSummaryRow[]> {
  const { results } = await db
    .prepare(
      'SELECT t.*, ' +
        '(SELECT COUNT(*) FROM comments AS c WHERE c.thread_id = t.id AND c.resolved_at IS NULL) AS open_comments, ' +
        "EXISTS (SELECT 1 FROM messages AS m WHERE m.thread_id = t.id AND m.kind = 'implementation_prompt') AS has_prompt " +
        'FROM threads AS t WHERE t.owner_sub = ? ORDER BY t.updated_at DESC LIMIT 200',
    )
    .bind(ownerSub)
    .all<ThreadSummaryRow>();
  return results;
}

export async function getThread(db: D1Database, id: string, ownerSub: string): Promise<ThreadRow | null> {
  return db.prepare('SELECT * FROM threads WHERE id = ? AND owner_sub = ?').bind(id, ownerSub).first<ThreadRow>();
}

export async function getThreadById(db: D1Database, id: string): Promise<ThreadRow | null> {
  return db.prepare('SELECT * FROM threads WHERE id = ?').bind(id).first<ThreadRow>();
}

export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export async function getThreadByShareToken(db: D1Database, token: string): Promise<ThreadRow | null> {
  if (!SHARE_TOKEN_PATTERN.test(token)) return null;
  return db.prepare('SELECT * FROM threads WHERE share_token = ?').bind(token).first<ThreadRow>();
}

/** Starts sharing a thread with a new token, or stops it (null). The old URL stops working either way. */
export async function setShareToken(db: D1Database, id: string, ownerSub: string, token: string | null): Promise<boolean> {
  const result = await db
    .prepare('UPDATE threads SET share_token = ?, shared_at = ? WHERE id = ? AND owner_sub = ?')
    .bind(token, token === null ? null : now(), id, ownerSub)
    .run();
  return result.meta.changes > 0;
}

export async function setThreadStatus(db: D1Database, id: string, status: ThreadStatus): Promise<void> {
  await db.prepare('UPDATE threads SET status = ?, updated_at = ? WHERE id = ?').bind(status, now(), id).run();
}

export async function touchThread(db: D1Database, id: string): Promise<void> {
  await db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').bind(now(), id).run();
}

export async function deleteThread(db: D1Database, id: string, ownerSub: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM threads WHERE id = ? AND owner_sub = ?').bind(id, ownerSub).run();
  return result.meta.changes > 0;
}

/** Adds a message of a person: a request, a reply, a request for an implementation prompt, or an edited plan. */
export async function addMessage(
  db: D1Database,
  input: {
    threadId: string;
    role: MessageRow['role'];
    kind: MessageKind;
    title?: string | null;
    body: string;
    questions?: Question[];
    author?: Author | null;
    changeSummary?: string | null;
    baseMessageId?: string | null;
  },
): Promise<MessageRow> {
  const id = newId('msg');
  const created = now();
  const questionsJson = input.questions && input.questions.length > 0 ? JSON.stringify(input.questions) : null;
  // The sequence number is taken in the same statement as the insert, so two
  // messages of one thread never get the same number (UNIQUE (thread_id, seq)).
  const row = await db
    .prepare(
      'INSERT INTO messages (id, thread_id, seq, run_id, role, kind, title, body, questions_json, author_sub, author_name, change_summary, base_message_id, created_at) ' +
        'SELECT ?, ?, COALESCE(MAX(seq), 0) + 1, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM messages WHERE thread_id = ? RETURNING *',
    )
    .bind(
      id,
      input.threadId,
      input.role,
      input.kind,
      input.title ?? null,
      input.body,
      questionsJson,
      input.author?.sub ?? null,
      input.author?.name ?? null,
      input.changeSummary ?? null,
      input.baseMessageId ?? null,
      created,
      input.threadId,
    )
    .first<MessageRow>();
  if (!row) throw new Error('Failed to insert the message');
  return row;
}

/**
 * Saves a version of the plan people edited, unless the plan changed since
 * they opened it (another edit, or a plan from Claude Code) or a run is
 * active (its result would replace the edit). Returns null in those cases.
 */
export async function addEditedPlan(
  db: D1Database,
  input: { threadId: string; baseMessageId: string; title: string | null; body: string; note: string | null; author: Author; resolveCommentIds: string[] },
): Promise<MessageRow | null> {
  const id = newId('msg');
  const created = now();
  const latestPlan = "(SELECT id FROM messages WHERE thread_id = ? AND kind = 'plan' ORDER BY seq DESC LIMIT 1)";
  const noActiveRun = "NOT EXISTS (SELECT 1 FROM runs WHERE thread_id = ? AND status IN ('firing', 'running'))";
  const [inserted] = await db.batch<MessageRow>([
    db
      .prepare(
        'INSERT INTO messages (id, thread_id, seq, run_id, role, kind, title, body, questions_json, author_sub, author_name, change_summary, base_message_id, created_at) ' +
          "SELECT ?, ?, COALESCE((SELECT MAX(seq) FROM messages WHERE thread_id = ?), 0) + 1, NULL, 'user', 'plan', ?, ?, NULL, ?, ?, ?, ?, ? " +
          `WHERE ${latestPlan} = ? AND ${noActiveRun} RETURNING *`,
      )
      .bind(
        id,
        input.threadId,
        input.threadId,
        input.title,
        input.body,
        input.author.sub,
        input.author.name,
        input.note,
        input.baseMessageId,
        created,
        input.threadId,
        input.baseMessageId,
        input.threadId,
      ),
    db
      .prepare('UPDATE threads SET updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM messages WHERE id = ?)')
      .bind(created, input.threadId, id),
    ...input.resolveCommentIds.map((commentId) =>
      db
        .prepare(
          "UPDATE comments SET resolved_at = ?, resolved_by = 'user', resolved_by_name = ? " +
            'WHERE id = ? AND thread_id = ? AND resolved_at IS NULL AND EXISTS (SELECT 1 FROM messages WHERE id = ?)',
        )
        .bind(created, input.author.name, commentId, input.threadId, id),
    ),
  ]);
  return inserted?.results[0] ?? null;
}

export async function listMessages(db: D1Database, threadId: string): Promise<MessageRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY seq')
    .bind(threadId)
    .all<MessageRow>();
  return results;
}

export async function countMessages(db: D1Database, threadId: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?').bind(threadId).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

/** The id of the latest version of the plan, the one comments go on; null before the first. */
export async function latestPlanId(db: D1Database, threadId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT id FROM messages WHERE thread_id = ? AND kind = 'plan' ORDER BY seq DESC LIMIT 1")
    .bind(threadId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

export async function getMessage(db: D1Database, threadId: string, id: string): Promise<MessageRow | null> {
  return db.prepare('SELECT * FROM messages WHERE thread_id = ? AND id = ?').bind(threadId, id).first<MessageRow>();
}

// ---------------------------------------------------------------------------
// Comments

export async function listComments(db: D1Database, threadId: string): Promise<CommentRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM comments WHERE thread_id = ? ORDER BY created_at, rowid')
    .bind(threadId)
    .all<CommentRow>();
  return results;
}

export async function countCommentsSince(db: D1Database, threadId: string, since: number): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS count FROM comments WHERE thread_id = ? AND created_at >= ?')
    .bind(threadId, since)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

/**
 * Adds a comment on a plan version of the thread, on one of its blocks
 * (anchorLine) or on the whole plan. Null when the message is not a plan of
 * the thread, or when the thread already took `limit.count` comments since
 * `limit.since` (checked in the insert, so parallel requests cannot pass it
 * together).
 */
export async function addComment(
  db: D1Database,
  input: {
    threadId: string;
    messageId: string;
    section: string | null;
    anchorLine?: number | null;
    quote: string | null;
    body: string;
    author: Author;
    limit: { count: number; since: number };
  },
): Promise<CommentRow | null> {
  return db
    .prepare(
      'INSERT INTO comments (id, thread_id, message_id, section, anchor_line, quote, body, author_sub, author_name, created_at) ' +
        "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM messages WHERE id = ? AND thread_id = ? AND kind = 'plan') " +
        'AND (SELECT COUNT(*) FROM comments WHERE thread_id = ? AND created_at >= ?) < ? RETURNING *',
    )
    .bind(
      newId('cmt'),
      input.threadId,
      input.messageId,
      input.section,
      input.anchorLine ?? null,
      input.quote,
      input.body,
      input.author.sub,
      input.author.name,
      now(),
      input.messageId,
      input.threadId,
      input.threadId,
      input.limit.since,
      input.limit.count,
    )
    .first<CommentRow>();
}

/** Marks a comment as resolved by a person, or open again (resolvedBy null). */
export async function setCommentResolved(
  db: D1Database,
  threadId: string,
  commentId: string,
  resolvedBy: { name: string | null } | null,
): Promise<boolean> {
  const result =
    resolvedBy === null
      ? await db
          .prepare('UPDATE comments SET resolved_at = NULL, resolved_by = NULL, resolved_by_name = NULL WHERE id = ? AND thread_id = ?')
          .bind(commentId, threadId)
          .run()
      : await db
          .prepare("UPDATE comments SET resolved_at = ?, resolved_by = 'user', resolved_by_name = ? WHERE id = ? AND thread_id = ? AND resolved_at IS NULL")
          .bind(now(), resolvedBy.name, commentId, threadId)
          .run();
  return result.meta.changes > 0;
}

export async function deleteComment(db: D1Database, threadId: string, commentId: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM comments WHERE id = ? AND thread_id = ?').bind(commentId, threadId).run();
  return result.meta.changes > 0;
}

// ---------------------------------------------------------------------------
// Runs

/** What a new run needs: its task, the hash of its token, and how long its result is waited for. */
export interface NewRun {
  task: RunTask;
  callbackTokenHash: string;
  ttlSeconds: number;
}

/**
 * The conditions a run starts under, checked in the same statement that
 * inserts it, so parallel requests cannot pass them together (D1 runs the
 * statements of a database one at a time): no run of the thread is active,
 * and the owner started fewer than `limit` runs since `since`. The binds are
 * threadId, ownerSub, since, limit.
 */
const RUN_ALLOWED =
  "NOT EXISTS (SELECT 1 FROM runs WHERE thread_id = ? AND status IN ('firing', 'running')) " +
  'AND (SELECT COUNT(*) FROM runs WHERE owner_sub = ? AND created_at >= ?) < ?';

function runRow(input: { id: string; threadId: string; ownerSub: string; triggerMessageId: string; run: NewRun; created: number }): RunRow {
  return {
    id: input.id,
    thread_id: input.threadId,
    owner_sub: input.ownerSub,
    task: input.run.task,
    trigger_message_id: input.triggerMessageId,
    status: 'firing',
    callback_token_hash: input.run.callbackTokenHash,
    session_id: null,
    session_url: null,
    progress_note: null,
    progress_at: null,
    error: null,
    created_at: input.created,
    completed_at: null,
    expires_at: input.created + input.run.ttlSeconds,
  };
}

/**
 * Adds a message of a person and the run that answers it, in one
 * transaction, only while a run may start (RUN_ALLOWED). Returns null when
 * it may not: nothing is written then.
 */
export async function addMessageWithRun(
  db: D1Database,
  input: {
    threadId: string;
    ownerSub: string;
    kind: Extract<MessageKind, 'request' | 'reply' | 'prompt_request'>;
    title?: string | null;
    body: string;
    author: Author;
    baseMessageId?: string | null;
    run: NewRun;
    limit: { count: number; since: number };
  },
): Promise<{ message: MessageRow; run: RunRow } | null> {
  const messageId = newId('msg');
  const runId = newId('run');
  const created = now();
  const recorded = 'EXISTS (SELECT 1 FROM messages WHERE id = ?)';
  const [inserted] = await db.batch<MessageRow>([
    db
      .prepare(
        'INSERT INTO messages (id, thread_id, seq, run_id, role, kind, title, body, questions_json, author_sub, author_name, change_summary, base_message_id, created_at) ' +
          "SELECT ?, ?, COALESCE((SELECT MAX(seq) FROM messages WHERE thread_id = ?), 0) + 1, NULL, 'user', ?, ?, ?, NULL, ?, ?, NULL, ?, ? " +
          `WHERE ${RUN_ALLOWED} RETURNING *`,
      )
      .bind(
        messageId,
        input.threadId,
        input.threadId,
        input.kind,
        input.title ?? null,
        input.body,
        input.author.sub,
        input.author.name,
        input.baseMessageId ?? null,
        created,
        input.threadId,
        input.ownerSub,
        input.limit.since,
        input.limit.count,
      ),
    db
      .prepare(
        'INSERT INTO runs (id, thread_id, owner_sub, task, trigger_message_id, status, callback_token_hash, created_at, expires_at) ' +
          `SELECT ?, ?, ?, ?, ?, 'firing', ?, ?, ? WHERE ${recorded}`,
      )
      .bind(runId, input.threadId, input.ownerSub, input.run.task, messageId, input.run.callbackTokenHash, created, created + input.run.ttlSeconds, messageId),
    db.prepare(`UPDATE threads SET status = 'running', updated_at = ? WHERE id = ? AND ${recorded}`).bind(created, input.threadId, messageId),
  ]);
  const message = inserted?.results[0];
  if (!message) return null;
  return { message, run: runRow({ id: runId, threadId: input.threadId, ownerSub: input.ownerSub, triggerMessageId: messageId, run: input.run, created }) };
}

/** Starts a run again for a message that already exists (a retry), only while a run may start (RUN_ALLOWED). */
export async function addRetryRun(
  db: D1Database,
  input: { threadId: string; ownerSub: string; triggerMessageId: string; run: NewRun; limit: { count: number; since: number } },
): Promise<RunRow | null> {
  const runId = newId('run');
  const created = now();
  const [inserted] = await db.batch<{ id: string }>([
    db
      .prepare(
        'INSERT INTO runs (id, thread_id, owner_sub, task, trigger_message_id, status, callback_token_hash, created_at, expires_at) ' +
          `SELECT ?, ?, ?, ?, ?, 'firing', ?, ?, ? WHERE ${RUN_ALLOWED} RETURNING id`,
      )
      .bind(
        runId,
        input.threadId,
        input.ownerSub,
        input.run.task,
        input.triggerMessageId,
        input.run.callbackTokenHash,
        created,
        created + input.run.ttlSeconds,
        input.threadId,
        input.ownerSub,
        input.limit.since,
        input.limit.count,
      ),
    db.prepare("UPDATE threads SET status = 'running', updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM runs WHERE id = ?)").bind(created, input.threadId, runId),
  ]);
  if (!inserted?.results[0]) return null;
  return runRow({ id: runId, threadId: input.threadId, ownerSub: input.ownerSub, triggerMessageId: input.triggerMessageId, run: input.run, created });
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
 * assistant's message, the end of the run, the thread's new status and the
 * replies to the comments. The message is inserted only while the run is
 * active, so of two callbacks for the same run only the first one is
 * recorded. It builds on the latest plan, which cannot change while the run
 * is active (people cannot edit the plan meanwhile). Returns the message, or
 * null when the run was no longer active.
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
    changeSummary?: string;
    commentReplies?: CommentReply[];
    error?: string;
  },
): Promise<MessageRow | null> {
  const id = newId('msg');
  const created = now();
  const questionsJson = input.questions.length > 0 ? JSON.stringify(input.questions) : null;
  const active = "EXISTS (SELECT 1 FROM runs WHERE id = ? AND status IN ('firing', 'running'))";
  const latestPlan = "(SELECT id FROM messages WHERE thread_id = ? AND kind = 'plan' ORDER BY seq DESC LIMIT 1)";
  const recorded = 'EXISTS (SELECT 1 FROM messages WHERE id = ?)';
  const [inserted] = await db.batch<MessageRow>([
    db
      .prepare(
        'INSERT INTO messages (id, thread_id, seq, run_id, role, kind, title, body, questions_json, author_sub, author_name, change_summary, base_message_id, created_at) ' +
          `SELECT ?, ?, COALESCE((SELECT MAX(seq) FROM messages WHERE thread_id = ?), 0) + 1, ?, 'assistant', ?, ?, ?, ?, NULL, NULL, ?, ${latestPlan}, ? ` +
          `WHERE ${active} RETURNING *`,
      )
      .bind(
        id,
        input.run.thread_id,
        input.run.thread_id,
        input.run.id,
        input.kind,
        input.title ?? null,
        input.body,
        questionsJson,
        input.changeSummary ?? null,
        input.run.thread_id,
        created,
        input.run.id,
      ),
    db
      .prepare(`UPDATE threads SET status = ?, updated_at = ? WHERE id = ? AND ${recorded}`)
      .bind(input.threadStatus, created, input.run.thread_id, id),
    // The replies of Claude Code; "resolved" closes a comment people have not closed yet.
    ...(input.commentReplies ?? []).map((reply) =>
      db
        .prepare(
          'UPDATE comments SET reply = ?, reply_run_id = ?, reply_at = ?, ' +
            "resolved_at = CASE WHEN ? = 1 AND resolved_at IS NULL THEN ? ELSE resolved_at END, " +
            "resolved_by = CASE WHEN ? = 1 AND resolved_at IS NULL THEN 'assistant' ELSE resolved_by END, " +
            'resolved_by_name = CASE WHEN ? = 1 AND resolved_at IS NULL THEN NULL ELSE resolved_by_name END ' +
            `WHERE id = ? AND thread_id = ? AND ${recorded}`,
        )
        .bind(
          reply.reply,
          input.run.id,
          created,
          reply.resolved ? 1 : 0,
          created,
          reply.resolved ? 1 : 0,
          reply.resolved ? 1 : 0,
          reply.id,
          input.run.thread_id,
          id,
        ),
    ),
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
