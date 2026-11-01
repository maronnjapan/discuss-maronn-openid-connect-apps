/**
 * The `text` of a routine fire: data only, as JSON.
 *
 * The routine's saved prompt (src/routine/prompt.ts) holds every instruction,
 * including where results go. A fire carries the identifiers of the run, the
 * request and the conversation, and nothing the routine is meant to obey.
 * JSON keeps the user's text inside string values, so a heading or a fake
 * instruction in a message cannot pass for a part of the structure, and the
 * routine checks run_id and run_token against fixed patterns before using
 * them.
 *
 * Only one plan goes in full: the latest version, in current_plan. The plans
 * and implementation prompts in the conversation carry no body, only their
 * version, what changed and why (changes) and which sections changed
 * (changed_sections), which together are the history of the plan. When
 * people edited the latest version, current_plan.user_changes holds what they
 * changed since Claude Code's last version, so the routine keeps it. The
 * routine reads an earlier version only when it needs it, one at a time
 * (GET /api/routine/runs/{runId}/plans/{version}).
 *
 * The routine receives this text wrapped in a <routine-fire-payload> block
 * that labels it untrusted.
 */
import { limitSectionChanges, sectionChanges, unifiedDiff, type SectionChanges } from '../plan-diff.js';
import type { Question } from './callback.js';
import { ROUTINE_TEXT_LIMIT } from './fire.js';

export const PAYLOAD_TYPE = 'maronn-planner.plan-request';
export const PAYLOAD_VERSION = 3;

export type MessageKind = 'request' | 'reply' | 'plan' | 'questions' | 'error' | 'prompt_request' | 'implementation_prompt';

/** What a run does: write or revise the plan, or turn the latest plan into a prompt for an AI coding agent. */
export type RunTask = 'plan' | 'implementation_prompt';

export interface PayloadMessage {
  seq: number;
  role: 'user' | 'assistant';
  kind: MessageKind;
  title?: string | null;
  body: string;
  questions?: Question[];
  /** Epoch seconds. */
  createdAt: number;
  /** Who wrote it, as shown to people (user messages and edited plans). */
  author?: string | null;
  /** Plans: what changed from the previous version and why. Implementation prompts: the notes of the formatting. */
  changeSummary?: string | null;
  /** Prompt requests and implementation prompts: the plan version they are about. */
  basePlanVersion?: number | null;
}

export interface PayloadComment {
  id: string;
  /** The plan version the comment was made on. */
  planVersion: number;
  section?: string | null;
  quote?: string | null;
  body: string;
  author?: string | null;
  /** Epoch seconds. */
  createdAt: number;
}

export interface PayloadInput {
  task: RunTask;
  runId: string;
  runToken: string;
  thread: { title: string; url: string };
  requester: { sub?: string | null; name?: string | null };
  /** Oldest first. The last user message is the one this run answers. */
  messages: PayloadMessage[];
  /** The open comments on the plan, oldest first. */
  comments?: PayloadComment[];
  maxLength?: number;
}

interface ConversationEntry {
  seq: number;
  role: 'user' | 'assistant';
  kind: MessageKind;
  title?: string;
  author?: string;
  created_at: string;
  body?: string;
  body_truncated?: true;
  /** Plans and implementation prompts: the body is left out (the latest plan is in current_plan). */
  body_omitted?: true;
  questions?: Question[];
  plan_version?: number;
  changes?: string;
  changed_sections?: Partial<SectionChanges>;
  notes?: string;
  based_on_version?: number;
}

interface CurrentPlan {
  version: number;
  seq: number;
  /** True when people edited this version in the planner. */
  edited_by_user: boolean;
  author?: string;
  title?: string;
  markdown?: string;
  /** The text did not fit; GET /api/routine/runs/{runId}/plans/{version} returns it. */
  markdown_omitted?: true;
  /** What people changed since the latest version from Claude Code. */
  user_changes?: {
    since_version: number;
    changed_sections: Partial<SectionChanges>;
    diff?: string;
    diff_omitted?: true;
  };
}

interface CommentEntry {
  id: string;
  plan_version: number;
  section?: string;
  quote?: string;
  body: string;
  author?: string;
  created_at: string;
}

/** The longest diff of people's edits sent with the plan; a longer one is left out (the plan itself is there). */
export const USER_DIFF_LIMIT = 12_000;

const iso = (epochSeconds: number) => new Date(epochSeconds * 1000).toISOString();

/** The version of each plan of a conversation, by seq: 1 for the first plan, 2 for the next, and so on. */
export function planVersionsBySeq(messages: readonly Pick<PayloadMessage, 'seq' | 'kind'>[]): Map<number, number> {
  const versions = new Map<number, number>();
  for (const message of messages) if (message.kind === 'plan') versions.set(message.seq, versions.size + 1);
  return versions;
}

/** The changed sections, each list cut to a few names and without the empty lists, to keep the payload short. */
function compactChanges(changes: SectionChanges): Partial<SectionChanges> {
  return Object.fromEntries(Object.entries(limitSectionChanges(changes)).filter(([, list]) => list.length > 0));
}

function conversationEntry(
  message: PayloadMessage,
  versions: Map<number, number>,
  previousPlan: PayloadMessage | undefined,
  body = message.body,
): ConversationEntry {
  const common = {
    seq: message.seq,
    role: message.role,
    kind: message.kind,
    ...(message.title ? { title: message.title } : {}),
    ...(message.author ? { author: message.author } : {}),
    created_at: iso(message.createdAt),
  };
  if (message.kind === 'plan') {
    return {
      ...common,
      body_omitted: true,
      plan_version: versions.get(message.seq)!,
      ...(message.changeSummary ? { changes: message.changeSummary } : {}),
      ...(previousPlan ? { changed_sections: compactChanges(sectionChanges(previousPlan.body, message.body)) } : {}),
    };
  }
  if (message.kind === 'implementation_prompt') {
    return {
      ...common,
      body_omitted: true,
      ...(message.basePlanVersion ? { based_on_version: message.basePlanVersion } : {}),
      ...(message.changeSummary ? { notes: message.changeSummary } : {}),
    };
  }
  return {
    ...common,
    body,
    ...(message.questions && message.questions.length > 0 ? { questions: message.questions } : {}),
    ...(message.kind === 'prompt_request' && message.basePlanVersion ? { based_on_version: message.basePlanVersion } : {}),
    ...(body !== message.body ? { body_truncated: true as const } : {}),
  };
}

function currentPlanEntry(messages: readonly PayloadMessage[], versions: Map<number, number>): CurrentPlan | null {
  const plans = messages.filter((message) => message.kind === 'plan');
  const current = plans[plans.length - 1];
  if (!current) return null;
  const version = versions.get(current.seq)!;
  const entry: CurrentPlan = {
    version,
    seq: current.seq,
    edited_by_user: current.role === 'user',
    ...(current.author ? { author: current.author } : {}),
    ...(current.title ? { title: current.title } : {}),
    markdown: current.body,
  };
  if (current.role === 'user') {
    const fromClaude = [...plans].reverse().find((plan) => plan.role === 'assistant');
    if (fromClaude) {
      const since = versions.get(fromClaude.seq)!;
      const diff = unifiedDiff(fromClaude.body, current.body, { fromLabel: `v${since}（Claude Code）`, toLabel: `v${version}（編集後）` });
      entry.user_changes = {
        since_version: since,
        changed_sections: compactChanges(sectionChanges(fromClaude.body, current.body)),
        ...(diff !== null && diff.length <= USER_DIFF_LIMIT ? { diff } : { diff_omitted: true as const }),
      };
    }
  }
  return entry;
}

function commentEntry(comment: PayloadComment): CommentEntry {
  return {
    id: comment.id,
    plan_version: comment.planVersion,
    ...(comment.section ? { section: comment.section } : {}),
    ...(comment.quote ? { quote: comment.quote } : {}),
    body: comment.body,
    ...(comment.author ? { author: comment.author } : {}),
    created_at: iso(comment.createdAt),
  };
}

/**
 * The fire text. When it is too long for the endpoint, it gives up what the
 * routine can do without or fetch again (GET .../context has all of it):
 *
 * 1. the diff of people's edits (the changed sections stay);
 * 2. messages between the first request and the latest ones, oldest first
 *    (omitted_seq lists them). The records of the plan versions in between
 *    have no body and stay;
 * 3. comments, oldest first (comments_omitted counts them);
 * 4. the text of the current plan (markdown_omitted; GET .../plans/{n}),
 *    with the messages and comments of steps 2 and 3 back as far as they fit.
 *
 * As a last resort only the first request, the message the run answers and
 * the last message stay, with their bodies cut.
 */
export function buildRoutinePayload(input: PayloadInput): string {
  const maxLength = Math.min(input.maxLength ?? ROUTINE_TEXT_LIMIT - 1_000, ROUTINE_TEXT_LIMIT);
  const messages = input.messages;
  const versions = planVersionsBySeq(messages);
  const previousPlans = new Map<number, PayloadMessage | undefined>();
  let lastPlan: PayloadMessage | undefined;
  for (const message of messages) {
    previousPlans.set(message.seq, lastPlan);
    if (message.kind === 'plan') lastPlan = message;
  }
  const entryOf = (message: PayloadMessage, body?: string) => conversationEntry(message, versions, previousPlans.get(message.seq), body);
  const comments = (input.comments ?? []).map(commentEntry);

  const compose = (current: CurrentPlan | null, conversation: ConversationEntry[], omittedSeq: number[], commentsDropped = 0) =>
    JSON.stringify(
      {
        type: PAYLOAD_TYPE,
        version: PAYLOAD_VERSION,
        task: input.task,
        run_id: input.runId,
        run_token: input.runToken,
        thread: input.thread,
        requester: {
          ...(input.requester.sub ? { sub: input.requester.sub } : {}),
          ...(input.requester.name ? { name: input.requester.name } : {}),
        },
        conversation,
        current_plan: current,
        comments: comments.slice(commentsDropped),
        ...(commentsDropped > 0 ? { comments_omitted: commentsDropped } : {}),
        omitted_seq: omittedSeq,
      },
      null,
      2,
    );

  // The routine needs these in any case: the first request, the message the run answers, and the last message.
  const answered = [...messages].reverse().find((message) => message.role === 'user' && message.kind !== 'plan');
  const kept = messages.filter((message, index) => index === 0 || index === messages.length - 1 || message === answered);
  const droppable = messages.filter((message) => !kept.includes(message) && message.kind !== 'plan' && message.kind !== 'implementation_prompt');
  const withDropped = (current: CurrentPlan | null, drop: number, commentsDropped = 0) => {
    const dropped = new Set(droppable.slice(0, drop));
    return compose(
      current,
      messages.filter((message) => !dropped.has(message)).map((message) => entryOf(message)),
      [...dropped].map((message) => message.seq),
      commentsDropped,
    );
  };
  // The smallest k in [0, n] whose text fits (the length never grows with k), or null.
  const smallestFitting = (n: number, build: (k: number) => string): string | null => {
    let text = build(n);
    if (text.length > maxLength) return null;
    let low = 0;
    let high = n;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = build(middle);
      if (candidate.length <= maxLength) {
        high = middle;
        text = candidate;
      } else {
        low = middle + 1;
      }
    }
    return text;
  };

  const full = currentPlanEntry(messages, versions);
  let text = withDropped(full, 0);
  if (text.length <= maxLength) return text;

  let withoutDiff = full;
  if (full?.user_changes?.diff !== undefined) {
    const { diff: _diff, ...rest } = full.user_changes;
    withoutDiff = { ...full, user_changes: { ...rest, diff_omitted: true } };
  }
  let withoutText = withoutDiff;
  if (withoutDiff?.markdown !== undefined) {
    const { markdown: _markdown, ...rest } = withoutDiff;
    withoutText = { ...rest, markdown_omitted: true };
  }
  for (const current of withoutText === withoutDiff ? [withoutDiff] : [withoutDiff, withoutText]) {
    const fitted =
      smallestFitting(droppable.length, (drop) => withDropped(current, drop)) ??
      smallestFitting(comments.length, (count) => withDropped(current, droppable.length, count));
    if (fitted) return fitted;
  }

  // The kept messages are too long themselves: cut their bodies.
  const omitted = messages.filter((message) => !kept.includes(message)).map((message) => message.seq);
  const overhead = compose(withoutText, kept.map((message) => entryOf(message, '')), omitted, comments.length).length + 100;
  // JSON escaping can grow a body (quotes, newlines, control characters), so leave room for it.
  let budget = Math.max(0, Math.floor((maxLength - overhead) / Math.max(1, kept.length) / 2));
  for (;;) {
    text = compose(
      withoutText,
      kept.map((message) => entryOf(message, message.body.length > budget ? message.body.slice(0, budget) : message.body)),
      omitted,
      comments.length,
    );
    if (text.length <= maxLength || budget === 0) return text;
    budget = Math.floor(budget * 0.8);
  }
}

const KIND_LABELS: Record<MessageKind, string> = {
  request: '依頼',
  reply: '回答・追加の指示',
  plan: '計画書',
  questions: '質問',
  error: 'エラー',
  prompt_request: '実装用プロンプトの依頼',
  implementation_prompt: '実装用プロンプト',
};

/** A code fence longer than every backtick run in the text, so the text cannot close it. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

const fenced = (text: string) => {
  const fence = fenceFor(text);
  return `${fence}markdown\n${text}\n${fence}`;
};

const oneLine = (text: string) => text.replace(/\s*\n\s*/g, ' ');

/**
 * The conversation as Markdown, for GET /api/routine/runs/{runId}/context:
 * every message in full except the plans and implementation prompts, the
 * latest plan once at the end, and the open comments. Like the fire, it
 * never holds more than one version of the plan.
 */
export function renderConversation(
  thread: { title: string },
  messages: PayloadMessage[],
  comments: PayloadComment[] = [],
): string {
  const versions = planVersionsBySeq(messages);
  const plans = messages.filter((message) => message.kind === 'plan');
  const current = plans[plans.length - 1];
  const sections = messages.map((message) => {
    const who = message.role === 'user' ? (message.author ?? 'ユーザー') : 'Claude Code';
    const title = message.title ? `「${message.title}」` : '';
    const version = versions.get(message.seq);
    const label = version ? `計画書 v${version}${message.role === 'user' ? '（人が編集）' : ''}` : KIND_LABELS[message.kind];
    const lines = [`## ${message.seq}. ${label}${title}（${who}、${iso(message.createdAt)}）`, ''];
    if (message.kind === 'plan') {
      lines.push(
        message === current
          ? '本文は末尾の「最新の計画書」にあります。'
          : `本文は省きました（GET /api/routine/runs/<run_id>/plans/${version} で取得できます）。`,
      );
      if (message.changeSummary) lines.push('', `変更点: ${oneLine(message.changeSummary)}`);
    } else if (message.kind === 'implementation_prompt') {
      lines.push(`本文は省きました（計画書 v${message.basePlanVersion ?? '?'} から作った実装用プロンプト）。`);
    } else {
      lines.push(fenced(message.body));
    }
    for (const question of message.questions ?? []) {
      const choices = question.choices?.length ? `（選択肢: ${question.choices.join(' / ')}）` : '';
      lines.push(`- ${question.id}: ${oneLine(question.question)}${choices}`);
    }
    return lines.join('\n');
  });
  if (current) {
    const version = versions.get(current.seq)!;
    sections.push(`# 最新の計画書（v${version}${current.role === 'user' ? '、人が編集' : ''}）\n\n${fenced(current.body)}`);
  }
  if (comments.length > 0) {
    const items = comments.map((comment) => {
      const where = [`v${comment.planVersion}`, comment.section ? `節「${comment.section}」` : '', comment.author ?? ''].filter(Boolean).join('、');
      const lines = [`## ${comment.id}（${where}、${iso(comment.createdAt)}）`, ''];
      if (comment.quote) lines.push(...comment.quote.split('\n').map((line) => `> ${line}`), '');
      lines.push(fenced(comment.body));
      return lines.join('\n');
    });
    sections.push(`# 未解決のコメント（${comments.length} 件）\n\n${items.join('\n\n')}`);
  }
  return [`# ${thread.title}`, ...sections].join('\n\n') + '\n';
}
