import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/markdown.js';

describe('renderMarkdown', () => {
  describe('CommonMark', () => {
    // CommonMark 0.31 §4.2 ATX headings, §4.8 paragraphs
    it('should render ATX headings and paragraphs', () => {
      expect(renderMarkdown('# 計画\n\n本文です。', { idPrefix: 'p' }).html).toBe(
        '<h1 id="p-h1">計画</h1>\n<p>本文です。</p>\n',
      );
    });

    // CommonMark §4.5 fenced code blocks: the info string's first word is the language
    it('should render a fenced code block with its language class and escaped content', () => {
      expect(renderMarkdown('```ts\nconst a = 1 < 2;\n```').html).toBe(
        '<pre><code class="language-ts">const a = 1 &lt; 2;\n</code></pre>\n',
      );
    });

    // CommonMark §5.2 list items and §5.3 lists
    it('should render ordered and bullet lists', () => {
      expect(renderMarkdown('1. 一つ目\n2. 二つ目\n\n- a\n- b').html).toBe(
        '<ol>\n<li>一つ目</li>\n<li>二つ目</li>\n</ol>\n<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n',
      );
    });

    // CommonMark §6.1 code spans, §6.2 emphasis
    it('should render code spans, emphasis and strong emphasis', () => {
      expect(renderMarkdown('`createApp` を *少し* **強く**').html).toBe(
        '<p><code>createApp</code> を <em>少し</em> <strong>強く</strong></p>\n',
      );
    });

    // CommonMark §6.7 soft line breaks stay soft (no <br>), §6.6 hard breaks with two spaces
    it('should keep soft line breaks and render hard line breaks', () => {
      expect(renderMarkdown('一行目\n二行目  \n三行目').html).toBe('<p>一行目\n二行目<br>\n三行目</p>\n');
    });

    // CommonMark §5.1 block quotes
    it('should render block quotes', () => {
      expect(renderMarkdown('> 注意').html).toBe('<blockquote>\n<p>注意</p>\n</blockquote>\n');
    });
  });

  describe('GitHub Flavored Markdown', () => {
    // GFM §4.10 tables
    it('should render a table inside a scroll wrapper', () => {
      expect(renderMarkdown('| ファイル | 変更 |\n| --- | :-: |\n| a.ts | 追加 |').html).toBe(
        '<div class="table-wrap"><table>\n<thead>\n<tr>\n<th>ファイル</th>\n<th style="text-align:center">変更</th>\n</tr>\n</thead>\n' +
          '<tbody>\n<tr>\n<td>a.ts</td>\n<td style="text-align:center">追加</td>\n</tr>\n</tbody>\n</table></div>\n',
      );
    });

    // GFM §5.3 task list items
    it('should render task list items as disabled checkboxes', () => {
      expect(renderMarkdown('- [ ] テストを書く\n- [x] 調査する').html).toBe(
        '<ul class="contains-task-list">\n' +
          '<li class="task-list-item"><input class="task-list-item-checkbox" disabled="" type="checkbox"> テストを書く</li>\n' +
          '<li class="task-list-item"><input class="task-list-item-checkbox" checked="" disabled="" type="checkbox"> 調査する</li>\n' +
          '</ul>\n',
      );
    });

    // GFM §6.5 strikethrough
    it('should render strikethrough', () => {
      expect(renderMarkdown('~~不要~~').html).toBe('<p><s>不要</s></p>\n');
    });

    // GFM §6.9 autolinks (extension): bare URLs become links opened in a new tab
    it('should link bare URLs and open external links in a new tab', () => {
      expect(renderMarkdown('https://www.rfc-editor.org/rfc/rfc9449').html).toBe(
        '<p><a href="https://www.rfc-editor.org/rfc/rfc9449" target="_blank" rel="noopener noreferrer">https://www.rfc-editor.org/rfc/rfc9449</a></p>\n',
      );
    });

    it('should render footnotes', () => {
      const { html } = renderMarkdown('本文[^1]\n\n[^1]: 補足');
      expect(html).toContain('<sup class="footnote-ref"><a href="#fn1" id="fnref1">[1]</a></sup>');
      expect(html).toContain('<li id="fn1" class="footnote-item"><p>補足 <a href="#fnref1" class="footnote-backref">↩︎</a></p>\n</li>');
    });
  });

  describe('Mermaid', () => {
    it('should render a mermaid fence as an escaped pre.mermaid block', () => {
      expect(renderMarkdown('```mermaid\nsequenceDiagram\n  RP->>OP: <authorize>\n```').html).toBe(
        '<pre class="mermaid">sequenceDiagram\n  RP-&gt;&gt;OP: &lt;authorize&gt;\n</pre>\n',
      );
    });
  });

  describe('Untrusted input', () => {
    it('should escape raw HTML blocks instead of passing them through', () => {
      expect(renderMarkdown('<script>alert(1)</script>').html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>\n');
    });

    it('should escape inline HTML', () => {
      expect(renderMarkdown('a <img src=x onerror=alert(1)> b').html).toBe(
        '<p>a &lt;img src=x onerror=alert(1)&gt; b</p>\n',
      );
    });

    it('should not link javascript: URLs', () => {
      expect(renderMarkdown('[click](javascript:alert(1))').html).toBe('<p>[click](javascript:alert(1))</p>\n');
    });

    it('should add lazy loading and no-referrer to images', () => {
      expect(renderMarkdown('![図](https://example.com/a.png)').html).toBe(
        '<p><img src="https://example.com/a.png" alt="図" loading="lazy" referrerpolicy="no-referrer"></p>\n',
      );
    });
  });

  describe('Headings', () => {
    it('should collect the headings with ids for a table of contents', () => {
      const { headings } = renderMarkdown('# 計画\n\n## 概要\n\n### `config.ts` の変更', { idPrefix: 'm1' });
      expect(headings).toEqual([
        { level: 1, text: '計画', id: 'm1-h1' },
        { level: 2, text: '概要', id: 'm1-h2' },
        { level: 3, text: 'config.ts の変更', id: 'm1-h3' },
      ]);
    });
  });
});
