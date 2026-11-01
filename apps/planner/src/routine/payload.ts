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
 * The routine receives this text wrapped in a <routine-fire-payload> block
 * that labels it untrusted.
 */
import { ROUTINE_TEXT_LIMIT } from './fire.js';
import type { Question } from './callback.js';

export const PAYLOAD_TYPE = 'maronn-planner.plan-request';
export const PAYLOAD_VERSION = 2;

export type MessageKind = 'request' | 'reply' | 'plan' | 'questions' | 'error';

export interface PayloadMessage {
  seq: number;
  role: 'user' | 'assistant';
  kind: MessageKind;
  title?: string | null;
  body: string;
  questions?: Question[];
  /** Epoch seconds. */
  createdAt: number;
}

export interface PayloadInput {
  runId: string;
  runToken: string;
  thread: { title: string; url: string };
  requester: { sub: string; name?: string | null };
  /** Oldest first. The last one is the user message this run answers. */
  messages: PayloadMessage[];
  maxLength?: number;
}

interface ConversationEntry {
  seq: number;
  role: 'user' | 'assistant';
  kind: MessageKind;
  title?: string;
  created_at: string;
  body: string;
  questions?: Question[];
  body_truncated?: true;
}

function entry(message: PayloadMessage, body = message.body): ConversationEntry {
  return {
    seq: message.seq,
    role: message.role,
    kind: message.kind,
    ...(message.title ? { title: message.title } : {}),
    created_at: new Date(message.createdAt * 1000).toISOString(),
    body,
    ...(message.questions && message.questions.length > 0 ? { questions: message.questions } : {}),
    ...(body !== message.body ? { body_truncated: true as const } : {}),
  };
}

/**
 * The fire text. When the conversation is too long for the endpoint, the
 * messages between the first request and the latest ones are left out
 * (omitted_seq lists them; the routine can read them from the context
 * endpoint), and as a last resort the bodies are cut.
 */
export function buildRoutinePayload(input: PayloadInput): string {
  const maxLength = Math.min(input.maxLength ?? ROUTINE_TEXT_LIMIT - 1_000, ROUTINE_TEXT_LIMIT);
  const compose = (conversation: ConversationEntry[], omitted: number[]) =>
    JSON.stringify(
      {
        type: PAYLOAD_TYPE,
        version: PAYLOAD_VERSION,
        run_id: input.runId,
        run_token: input.runToken,
        thread: input.thread,
        requester: { sub: input.requester.sub, ...(input.requester.name ? { name: input.requester.name } : {}) },
        conversation,
        omitted_seq: omitted,
      },
      null,
      2,
    );

  const messages = input.messages;
  const full = compose(messages.map((message) => entry(message)), []);
  if (full.length <= maxLength) return full;

  // Keep the first request and as many of the latest messages as fit.
  const first = messages[0];
  if (first) {
    for (let keep = messages.length - 2; keep >= 1; keep--) {
      const latest = messages.slice(messages.length - keep);
      const omitted = messages.slice(1, messages.length - keep).map((message) => message.seq);
      const text = compose([entry(first), ...latest.map((message) => entry(message))], omitted);
      if (text.length <= maxLength) return text;
    }
  }

  // Even the first and the last message are too long: cut their bodies.
  const last = messages[messages.length - 1];
  const kept = [first, last].filter((message, index, all): message is PayloadMessage => message !== undefined && all.indexOf(message) === index);
  const omitted = messages.filter((message) => !kept.includes(message)).map((message) => message.seq);
  const overhead = compose(kept.map((message) => entry(message, '')), omitted).length + 100;
  // JSON escaping can grow a body (quotes, newlines, control characters), so leave room for it.
  let budget = Math.max(0, Math.floor((maxLength - overhead) / kept.length / 2));
  for (;;) {
    const text = compose(
      kept.map((message) => entry(message, message.body.length > budget ? message.body.slice(0, budget) : message.body)),
      omitted,
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
};

/** A code fence longer than every backtick run in the text, so the text cannot close it. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** The whole conversation as Markdown, for GET /api/routine/runs/{runId}/context. */
export function renderConversation(thread: { title: string }, messages: PayloadMessage[]): string {
  const sections = messages.map((message) => {
    const who = message.role === 'user' ? 'ユーザー' : 'Claude Code';
    const title = message.title ? `「${message.title}」` : '';
    const fence = fenceFor(message.body);
    const lines = [
      `## ${message.seq}. ${KIND_LABELS[message.kind]}${title}（${who}、${new Date(message.createdAt * 1000).toISOString()}）`,
      '',
      `${fence}markdown\n${message.body}\n${fence}`,
    ];
    for (const question of message.questions ?? []) {
      const choices = question.choices?.length ? `（選択肢: ${question.choices.join(' / ')}）` : '';
      lines.push(`- ${question.id}: ${question.question.replace(/\s*\n\s*/g, ' ')}${choices}`);
    }
    return lines.join('\n');
  });
  return [`# ${thread.title}`, ...sections].join('\n\n') + '\n';
}
