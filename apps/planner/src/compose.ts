/** Turning the forms of the pages into the Markdown messages of a thread. */
import type { Question } from './routine/callback.js';

export const LIMITS = {
  title: 120,
  feature: 20_000,
  specs: 500,
  notes: 10_000,
  message: 20_000,
  answer: 10_000,
  instructions: 4_000,
  editNote: 2_000,
  comment: 4_000,
  quote: 1_000,
  section: 200,
  name: 40,
} as const;

export function formString(form: Record<string, unknown>, name: string): string {
  const value = form[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first.replace(/\r\n?/g, '\n').trim() : '';
}

/** Every value of a field that can repeat, such as checkboxes (parseBody({ all: true })). */
export function formStrings(form: Record<string, unknown>, name: string): string[] {
  const value = form[name];
  return (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === 'string');
}

export interface NewPlanValues {
  title: string;
  feature: string;
  specs: string;
  notes: string;
}

export function composeRequest(values: NewPlanValues): string {
  const sections = [`## 作りたい機能\n\n${values.feature}`];
  if (values.specs) sections.push(`## 関連する仕様\n\n${values.specs}`);
  if (values.notes) sections.push(`## 前提・制約・補足\n\n${values.notes}`);
  return sections.join('\n\n');
}

/** What a reply says when its form was left empty but comments on the plan are open: they go with the run. */
export const REPLY_FOR_COMMENTS = '未解決のコメントを反映して、計画書を直してください。';

/**
 * Turns the answer form into one Markdown message: each question, its choice
 * and its answer. Null when nothing was written, unless there are open
 * comments to send (the message then asks to address them).
 */
export function composeReply(questions: Question[], form: Record<string, unknown>, options: { openComments?: number } = {}): string | null {
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
  if (!answered) return (options.openComments ?? 0) > 0 && questions.length === 0 ? REPLY_FOR_COMMENTS : null;
  return parts.join('\n\n');
}

/** The message that asks for an implementation prompt of a plan version, with the formatting instructions. */
export function composePromptRequest(planVersion: number, instructions: string): string {
  const request = `計画書 v${planVersion} から、生成 AI に実装させるためのプロンプトを作ってください。`;
  return instructions ? `${request}\n\n## 整形の指示\n\n${instructions}` : request;
}

/**
 * The name a visitor of a share link gives: one line, no control
 * characters, at most LIMITS.name characters. Null when empty.
 */
export function guestName(value: string): string | null {
  const name = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LIMITS.name);
  return name === '' ? null : name;
}
