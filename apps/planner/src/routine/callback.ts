/**
 * What the routine sends back: the body of
 * POST /api/routine/runs/{runId}/messages (src/routes/routine-api.ts).
 *
 * JSON (the form the saved prompt of src/routine/prompt.ts asks for):
 *
 *   {
 *     "kind": "plan" | "questions" | "progress" | "error" | "implementation_prompt",
 *     "title": "計画書のタイトル",            // optional
 *     "markdown": "# ...",                    // required
 *     "questions": [                          // kind "questions" only, optional
 *       { "id": "q1", "question": "...", "choices": ["A", "B"] }
 *     ],
 *     "changes": "前の版からの変更点と理由",   // kind "plan" only, optional
 *     "comment_replies": [                    // kinds "plan" and "questions", optional
 *       { "id": "cmt_...", "resolved": true, "reply": "どう反映したか" }
 *     ],
 *     "notes": "整形で気づいたこと"            // kind "implementation_prompt" only, optional
 *   }
 *
 * A text/markdown body is accepted too, with kind and title in the query
 * string, so a plan can be sent with `curl --data-binary @plan.md` when
 * building JSON is inconvenient.
 */

export const CALLBACK_KINDS = ['plan', 'questions', 'progress', 'error', 'implementation_prompt'] as const;
export type CallbackKind = (typeof CALLBACK_KINDS)[number];

/** The kinds a run may send back, by its task (a run turning a plan into a prompt sends no plan). */
export const CALLBACK_KINDS_BY_TASK = {
  plan: ['plan', 'questions', 'progress', 'error'],
  implementation_prompt: ['implementation_prompt', 'progress', 'error'],
} as const satisfies Record<string, readonly CallbackKind[]>;

export interface Question {
  id: string;
  question: string;
  choices?: string[];
}

/** Claude Code's answer to one comment on the plan: whether the new plan addresses it, and how or why not. */
export interface CommentReply {
  id: string;
  resolved: boolean;
  reply: string;
}

export interface CallbackMessage {
  kind: CallbackKind;
  title?: string;
  markdown: string;
  questions: Question[];
  /** Plans: what changed from the version the run started from, and why. */
  changes?: string;
  /** Implementation prompts: what the formatting noticed (a plan that does not match the code, refused instructions). */
  notes?: string;
  commentReplies: CommentReply[];
}

export const LIMITS = {
  bodyBytes: 512 * 1024,
  markdown: 200_000,
  progressMarkdown: 4_000,
  title: 200,
  questions: 20,
  question: 4_000,
  choices: 10,
  choice: 500,
  changes: 4_000,
  commentReplies: 100,
  commentReply: 2_000,
} as const;

const QUESTION_ID = /^[A-Za-z0-9_-]{1,32}$/;
export const COMMENT_ID = /^cmt_[0-9a-f]{24}$/;

export type ParseResult = { ok: true; message: CallbackMessage } | { ok: false; error: string };

function fail(error: string): ParseResult {
  return { ok: false, error };
}

function cleanTitle(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null;
  const title = value.replace(/\s+/g, ' ').trim();
  if (title.length > LIMITS.title) return null;
  return title === '' ? undefined : title;
}

/** The text of the first ATX heading, as the title of a plan sent without one. */
export function firstHeading(markdown: string): string | undefined {
  const match = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(markdown);
  return match?.[1]?.trim().slice(0, LIMITS.title) || undefined;
}

export function parseCallbackBody(contentType: string, raw: string, query: URLSearchParams): ParseResult {
  const mediaType = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  let input: Record<string, unknown>;
  if (mediaType === 'application/json') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return fail('The body must be a JSON object.');
      }
      input = parsed as Record<string, unknown>;
    } catch {
      return fail('The body is not valid JSON.');
    }
  } else if (mediaType === 'text/markdown' || mediaType === 'text/plain') {
    input = { kind: query.get('kind') ?? 'plan', title: query.get('title') ?? undefined, markdown: raw };
  } else {
    return fail('Content-Type must be application/json or text/markdown.');
  }

  const kind = input.kind;
  if (typeof kind !== 'string' || !(CALLBACK_KINDS as readonly string[]).includes(kind)) {
    return fail(`"kind" must be one of ${CALLBACK_KINDS.join(', ')}.`);
  }

  const markdown = typeof input.markdown === 'string' ? input.markdown.replace(/\r\n?/g, '\n').trim() : '';
  if (markdown === '') return fail('"markdown" must be a non-empty string.');
  const markdownLimit = kind === 'progress' ? LIMITS.progressMarkdown : LIMITS.markdown;
  if (markdown.length > markdownLimit) return fail(`"markdown" must be at most ${markdownLimit} characters.`);

  const title = cleanTitle(input.title);
  if (title === null) return fail(`"title" must be a string of at most ${LIMITS.title} characters.`);

  const questions: Question[] = [];
  if (input.questions !== undefined && input.questions !== null) {
    if (kind !== 'questions') return fail('"questions" is only allowed with kind "questions".');
    if (!Array.isArray(input.questions)) return fail('"questions" must be an array.');
    if (input.questions.length > LIMITS.questions) return fail(`At most ${LIMITS.questions} questions are allowed.`);
    const ids = new Set<string>();
    for (const [index, entry] of input.questions.entries()) {
      if (typeof entry !== 'object' || entry === null) return fail(`questions[${index}] must be an object.`);
      const { id, question, choices } = entry as Record<string, unknown>;
      const questionId = typeof id === 'string' && id !== '' ? id : `q${index + 1}`;
      if (!QUESTION_ID.test(questionId)) return fail(`questions[${index}].id must match ${QUESTION_ID}.`);
      if (ids.has(questionId)) return fail(`questions[${index}].id "${questionId}" is used twice.`);
      ids.add(questionId);
      if (typeof question !== 'string' || question.trim() === '') {
        return fail(`questions[${index}].question must be a non-empty string.`);
      }
      if (question.length > LIMITS.question) return fail(`questions[${index}].question is too long.`);
      let cleanChoices: string[] | undefined;
      if (choices !== undefined && choices !== null) {
        if (!Array.isArray(choices) || choices.length > LIMITS.choices) {
          return fail(`questions[${index}].choices must be an array of at most ${LIMITS.choices} strings.`);
        }
        cleanChoices = [];
        for (const choice of choices) {
          if (typeof choice !== 'string' || choice.trim() === '' || choice.length > LIMITS.choice) {
            return fail(`questions[${index}].choices must be non-empty strings of at most ${LIMITS.choice} characters.`);
          }
          cleanChoices.push(choice.trim());
        }
        if (cleanChoices.length === 0) cleanChoices = undefined;
      }
      questions.push({ id: questionId, question: question.trim(), ...(cleanChoices ? { choices: cleanChoices } : {}) });
    }
  }

  const changes = optionalText(input.changes, 'changes', 'plan', kind);
  if (typeof changes === 'object') return changes;
  const notes = optionalText(input.notes, 'notes', 'implementation_prompt', kind);
  if (typeof notes === 'object') return notes;

  const commentReplies: CommentReply[] = [];
  if (input.comment_replies !== undefined && input.comment_replies !== null) {
    if (kind !== 'plan' && kind !== 'questions') return fail('"comment_replies" is only allowed with kind "plan" or "questions".');
    if (!Array.isArray(input.comment_replies)) return fail('"comment_replies" must be an array.');
    if (input.comment_replies.length > LIMITS.commentReplies) return fail(`At most ${LIMITS.commentReplies} comment replies are allowed.`);
    const ids = new Set<string>();
    for (const [index, entry] of input.comment_replies.entries()) {
      if (typeof entry !== 'object' || entry === null) return fail(`comment_replies[${index}] must be an object.`);
      const { id, resolved, reply } = entry as Record<string, unknown>;
      if (typeof id !== 'string' || !COMMENT_ID.test(id)) return fail(`comment_replies[${index}].id must be a comment id (cmt_ and 24 hex digits).`);
      if (ids.has(id)) return fail(`comment_replies[${index}].id "${id}" is used twice.`);
      ids.add(id);
      if (typeof resolved !== 'boolean') return fail(`comment_replies[${index}].resolved must be true or false.`);
      if (typeof reply !== 'string' || reply.trim() === '') return fail(`comment_replies[${index}].reply must be a non-empty string.`);
      if (reply.length > LIMITS.commentReply) return fail(`comment_replies[${index}].reply must be at most ${LIMITS.commentReply} characters.`);
      commentReplies.push({ id, resolved, reply: reply.replace(/\r\n?/g, '\n').trim() });
    }
  }

  const resolvedTitle = title ?? (kind === 'plan' || kind === 'implementation_prompt' ? firstHeading(markdown) : undefined);
  return {
    ok: true,
    message: {
      kind: kind as CallbackKind,
      ...(resolvedTitle ? { title: resolvedTitle } : {}),
      markdown,
      questions,
      ...(changes ? { changes } : {}),
      ...(notes ? { notes } : {}),
      commentReplies,
    },
  };
}

/** An optional Markdown field of one kind: the text, undefined, or the failure. */
function optionalText(value: unknown, name: string, allowedKind: CallbackKind, kind: string): string | undefined | { ok: false; error: string } {
  if (value === undefined || value === null) return undefined;
  if (kind !== allowedKind) return { ok: false, error: `"${name}" is only allowed with kind "${allowedKind}".` };
  if (typeof value !== 'string') return { ok: false, error: `"${name}" must be a string.` };
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (text.length > LIMITS.changes) return { ok: false, error: `"${name}" must be at most ${LIMITS.changes} characters.` };
  return text === '' ? undefined : text;
}
