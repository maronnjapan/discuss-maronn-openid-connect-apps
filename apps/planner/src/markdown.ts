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
 */
import MarkdownIt, { type Token } from 'markdown-it';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';

export interface Heading {
  level: number;
  text: string;
  id: string;
}

export interface RenderedMarkdown {
  html: string;
  headings: Heading[];
}

type RenderEnv = {
  idPrefix: string;
  headings: Heading[];
};

const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });
md.use(taskLists, { enabled: false, label: false });
md.use(footnote);

// Heading ids, unique within a page by the prefix of each rendered document,
// so the table of contents of a plan can link to its sections.
md.core.ruler.push('heading_ids', (state) => {
  const env = state.env as Partial<RenderEnv>;
  if (!env.headings) return;
  let count = 0;
  state.tokens.forEach((token: Token, index: number) => {
    if (token.type !== 'heading_open') return;
    const inline = state.tokens[index + 1];
    const text = inline?.children?.filter((child) => child.type === 'text' || child.type === 'code_inline')
      .map((child) => child.content)
      .join('') ?? '';
    count += 1;
    const id = `${env.idPrefix ?? 'md'}-h${count}`;
    token.attrSet('id', id);
    env.headings!.push({ level: Number(token.tag.slice(1)), text, id });
  });
});

const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, index, options, env, self) => {
  const token = tokens[index]!;
  const language = token.info.trim().split(/\s+/)[0] ?? '';
  if (language === 'mermaid') {
    return `<pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>\n`;
  }
  return defaultFence(tokens, index, options, env, self);
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
md.renderer.rules.table_open = () => '<div class="table-wrap"><table>\n';
md.renderer.rules.table_close = () => '</table></div>\n';

export function renderMarkdown(source: string, options: { idPrefix?: string } = {}): RenderedMarkdown {
  const env: RenderEnv = { idPrefix: options.idPrefix ?? 'md', headings: [] };
  const html = md.render(source, env as unknown as Record<PropertyKey, unknown>);
  return { html, headings: env.headings };
}
