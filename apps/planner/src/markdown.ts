/**
 * Markdown rendering for the plans, questions and requests.
 *
 * markdown-it follows the CommonMark spec, and with its default preset it
 * also renders the GitHub Flavored Markdown extensions tables and
 * strikethrough. Task lists and footnotes (which GitHub renders too) come from
 * plugins, and bare URLs are linked (GFM autolinks, through linkify).
 *
 * The text comes from Claude Code and from users, so raw HTML is never
 * passed through (html: false escapes it), and markdown-it's validateLink
 * drops javascript:, vbscript:, file: and non-image data: URLs.
 *
 * ```mermaid fences become <pre class="mermaid"> with the escaped source,
 * which public/assets/app.js renders into a diagram in the browser.
 *
 * A plan is rendered with its blocks (renderMarkdown's `blocks` option): the
 * headings, paragraphs, list items, tables and code blocks people comment on.
 * Each gets the line of the Markdown where it starts as data-line, and a
 * comment slot (an HTML comment, see splitAtCommentSlots) marks where the
 * comments on it go. The text of a version never changes, so the line names
 * the block for good.
 */
import MarkdownIt, { type StateCore, type Token } from 'markdown-it';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';

export interface Heading {
  level: number;
  text: string;
  id: string;
}

export type PlanBlockKind = 'heading' | 'paragraph' | 'item' | 'table' | 'code';

/** A block of a plan that people can comment on. */
export interface PlanBlock {
  /** The line of the Markdown where the block starts (1-based). No two blocks of a document start on the same line. */
  line: number;
  /** The last line of the block (1-based, inclusive). A list item takes in its nested lists. */
  endLine: number;
  kind: PlanBlockKind;
  /** The level-2 heading the block is under (a level-2 heading is under itself); null before the first one. */
  section: string | null;
  /** Headings: their level (1–6). */
  level?: number;
  /** Headings: their text. */
  text?: string;
}

export interface RenderedMarkdown {
  html: string;
  headings: Heading[];
  /** With the `blocks` option: the blocks in the order of the document. */
  blocks: PlanBlock[];
}

type RenderEnv = {
  idPrefix: string;
  headings: Heading[];
  blocks?: PlanBlock[];
};

const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });
md.use(taskLists, { enabled: false, label: false });
md.use(footnote);

const inlineText = (inline: Token | undefined) =>
  inline?.children
    ?.filter((child) => child.type === 'text' || child.type === 'code_inline')
    .map((child) => child.content)
    .join('') ?? '';

// Heading ids, unique within a page by the prefix of each rendered document,
// so the table of contents of a plan can link to its sections.
md.core.ruler.push('heading_ids', (state) => {
  const env = state.env as Partial<RenderEnv>;
  if (!env.headings) return;
  let count = 0;
  state.tokens.forEach((token: Token, index: number) => {
    if (token.type !== 'heading_open') return;
    count += 1;
    const id = `${env.idPrefix ?? 'md'}-h${count}`;
    token.attrSet('id', id);
    env.headings!.push({ level: Number(token.tag.slice(1)), text: inlineText(state.tokens[index + 1]), id });
  });
});

const BLOCK_KINDS: Partial<Record<string, PlanBlockKind>> = {
  heading_open: 'heading',
  paragraph_open: 'paragraph',
  list_item_open: 'item',
  table_open: 'table',
  fence: 'code',
  code_block: 'code',
};
const CLOSING: Partial<Record<string, string>> = { heading_open: 'heading_close', paragraph_open: 'paragraph_close', table_open: 'table_close' };

/** The token after the end of a block, by the level its closing token has. */
function closingIndex(tokens: Token[], open: number, type: string): number {
  const level = tokens[open]!.level;
  for (let index = open + 1; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type === type && token.level === level) return index;
  }
  return tokens.length - 1;
}

/**
 * Where the comments on a list item go: before its nested list, so they stay
 * next to the item's own text, or at the end of the item.
 */
function itemSlotIndex(tokens: Token[], open: number): number {
  const level = tokens[open]!.level;
  for (let index = open + 1; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type === 'list_item_close' && token.level === level) return index;
    if ((token.type === 'bullet_list_open' || token.type === 'ordered_list_open') && token.level === level + 1) return index;
  }
  return tokens.length;
}

/**
 * The blocks people comment on, marked with data-line and followed by a
 * comment slot. A list item is one block with everything in it but its
 * nested items (so a paragraph, code or a table in an item belongs to the
 * item); of items that start on the same line ("1. - a") the innermost one
 * counts. Footnotes are not blocks.
 */
function markBlocks(state: StateCore, blocks: PlanBlock[]): void {
  const tokens = state.tokens;
  const chosen = new Map<number, number>();
  let items = 0;
  let footnotes = 0;
  tokens.forEach((token, index) => {
    if (token.type === 'footnote_block_open') footnotes += 1;
    if (token.type === 'footnote_block_close') footnotes -= 1;
    if (token.type === 'list_item_close') items -= 1;
    const inItem = items > 0;
    if (token.type === 'list_item_open') items += 1;
    const kind = BLOCK_KINDS[token.type];
    if (!kind || !token.map || token.hidden || footnotes > 0 || (kind !== 'item' && inItem)) return;
    chosen.set(token.map[0] + 1, index);
  });

  const marked = new Set(chosen.values());
  const before = new Map<number, number>();
  const after = new Map<number, number>();
  let section: string | null = null;
  tokens.forEach((token, index) => {
    if (token.type === 'heading_open' && (token.tag === 'h1' || token.tag === 'h2')) {
      section = token.tag === 'h2' ? inlineText(tokens[index + 1]) : null;
    }
    if (!marked.has(index)) return;
    const kind = BLOCK_KINDS[token.type]!;
    const line = token.map![0] + 1;
    blocks.push({
      line,
      endLine: Math.max(line, token.map![1]),
      kind,
      section,
      ...(kind === 'heading' ? { level: Number(token.tag.slice(1)), text: inlineText(tokens[index + 1]) } : {}),
    });
    // Fences and tables render through the rules below, which put the line on <pre> and on the wrapper of the table.
    if (token.type === 'fence' || token.type === 'table_open') token.meta = { ...token.meta, line };
    else token.attrSet('data-line', String(line));
    if (kind === 'item') before.set(itemSlotIndex(tokens, index), line);
    else after.set(token.type === 'fence' || token.type === 'code_block' ? index : closingIndex(tokens, index, CLOSING[token.type]!), line);
  });

  const slot = (line: number) => {
    const token = new state.Token('comment_slot', '', 0);
    token.block = true;
    token.meta = { line };
    return token;
  };
  const withSlots: Token[] = [];
  tokens.forEach((token, index) => {
    if (before.has(index)) withSlots.push(slot(before.get(index)!));
    withSlots.push(token);
    if (after.has(index)) withSlots.push(slot(after.get(index)!));
  });
  if (before.has(tokens.length)) withSlots.push(slot(before.get(tokens.length)!));
  state.tokens = withSlots;
}

md.core.ruler.push('plan_blocks', (state) => {
  const env = state.env as Partial<RenderEnv>;
  if (env.blocks) markBlocks(state, env.blocks);
});

const COMMENT_SLOT = /<!--comment-slot:([0-9]+)-->/;
md.renderer.rules.comment_slot = (tokens, index) => `<!--comment-slot:${Number(tokens[index]!.meta?.line)}-->`;

const lineAttribute = (token: Token) => (typeof token.meta?.line === 'number' ? ` data-line="${token.meta.line}"` : '');

const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, index, options, env, self) => {
  const token = tokens[index]!;
  const language = token.info.trim().split(/\s+/)[0] ?? '';
  const line = lineAttribute(token);
  if (language === 'mermaid') {
    return `<pre class="mermaid"${line}>${md.utils.escapeHtml(token.content)}</pre>\n`;
  }
  const html = defaultFence(tokens, index, options, env, self);
  return line ? html.replace(/^<pre/, `<pre${line}`) : html;
};

const defaultLinkOpen =
  md.renderer.rules.link_open ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index]!;
  const href = String(token.attrGet('href') ?? '');
  if (/^https?:\/\//i.test(href)) {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
  }
  return defaultLinkOpen(tokens, index, options, env, self);
};

const defaultImage = md.renderer.rules.image!;
md.renderer.rules.image = (tokens, index, options, env, self) => {
  const token = tokens[index]!;
  token.attrSet('loading', 'lazy');
  token.attrSet('referrerpolicy', 'no-referrer');
  return defaultImage(tokens, index, options, env, self);
};

// Wide tables scroll inside their own box instead of widening the page.
md.renderer.rules.table_open = (tokens, index) => `<div class="table-wrap"${lineAttribute(tokens[index]!)}><table>\n`;
md.renderer.rules.table_close = () => '</table></div>\n';

export function renderMarkdown(source: string, options: { idPrefix?: string; blocks?: boolean } = {}): RenderedMarkdown {
  const env: RenderEnv = { idPrefix: options.idPrefix ?? 'md', headings: [], ...(options.blocks ? { blocks: [] } : {}) };
  const html = md.render(source, env as unknown as Record<PropertyKey, unknown>);
  return { html, headings: env.headings, blocks: env.blocks ?? [] };
}

/** The blocks of a plan, as renderMarkdown(source, { blocks: true }) marks them, without rendering it. */
export function planBlocks(source: string): PlanBlock[] {
  const env: RenderEnv = { idPrefix: 'md', headings: [], blocks: [] };
  md.parse(source, env as unknown as Record<PropertyKey, unknown>);
  return env.blocks!;
}

/**
 * The HTML of a plan rendered with its blocks, cut at the comment slots: the
 * HTML before the first slot, then the line of that slot's block and the
 * HTML up to the next slot, and so on.
 */
export function splitAtCommentSlots(html: string): { html: string; slots: { line: number; html: string }[] } {
  const parts = html.split(COMMENT_SLOT);
  const slots: { line: number; html: string }[] = [];
  for (let index = 1; index < parts.length; index += 2) slots.push({ line: Number(parts[index]), html: parts[index + 1] ?? '' });
  return { html: parts[0] ?? '', slots };
}

/**
 * The Markdown of a block, on one line and cut to `length` characters: what
 * the routine reads to know which block a comment is on.
 */
export function blockExcerpt(source: string, block: Pick<PlanBlock, 'line' | 'endLine'>, length = 200): string {
  const text = source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .slice(block.line - 1, block.endLine)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ');
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
