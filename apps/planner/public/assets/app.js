// maronn Planner — browser behavior: waiting for Claude Code, diagrams,
// code highlighting, Markdown preview, copying, comments in place on the
// plan, and the name of a visitor of a share link.

const MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@12.2.0/dist/mermaid.esm.min.mjs';
const HLJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1';

const prefersDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

// --- Mermaid diagrams (```mermaid fences render as <pre class="mermaid">) ---
let mermaidPromise;
async function renderDiagrams(root = document) {
  // A diagram inside a closed <details> (an earlier version of the plan) has
  // no size to draw at; it is drawn when the <details> opens.
  const blocks = [...root.querySelectorAll('pre.mermaid:not([data-processed])')].filter((block) => !block.closest('details:not([open])'));
  if (blocks.length === 0) return;
  try {
    mermaidPromise ??= import(MERMAID_URL).then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: prefersDark() ? 'dark' : 'default' });
      return mermaid;
    });
    const mermaid = await mermaidPromise;
    await mermaid.run({ nodes: blocks, suppressErrors: true });
  } catch (error) {
    // The source stays visible as text when the diagram cannot be drawn.
    console.warn('mermaid', error);
  }
}

// --- Code highlighting (highlight.js) ---
let hljsPromise;
function loadHighlighter() {
  hljsPromise ??= new Promise((resolve, reject) => {
    for (const [theme, media] of [['github', '(prefers-color-scheme: light)'], ['github-dark', '(prefers-color-scheme: dark)']]) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `${HLJS_BASE}/styles/${theme}.min.css`;
      link.media = media;
      document.head.append(link);
    }
    const script = document.createElement('script');
    script.src = `${HLJS_BASE}/highlight.min.js`;
    script.onload = () => resolve(window.hljs);
    script.onerror = reject;
    document.head.append(script);
  });
  return hljsPromise;
}

async function highlight(root = document) {
  const blocks = [...root.querySelectorAll('.markdown-body pre > code[class*="language-"]:not(.hljs)')];
  if (blocks.length === 0) return;
  try {
    const hljs = await loadHighlighter();
    for (const block of blocks) {
      const language = [...block.classList].find((name) => name.startsWith('language-'))?.slice(9);
      if (language && hljs.getLanguage(language)) hljs.highlightElement(block);
    }
  } catch (error) {
    console.warn('highlight.js', error);
  }
}

/** Draws the diagrams and highlights the code; resolves when both are done (or gave up). */
function enhance(root = document) {
  return Promise.allSettled([renderDiagrams(root), highlight(root)]);
}

function setupCollapsedVersions() {
  for (const details of document.querySelectorAll('details.message--collapsed')) {
    details.addEventListener('toggle', () => {
      if (details.open) enhance(details);
    });
  }
}

// --- Text people are writing: a reload must not throw it away ---
function hasDraft() {
  return [...document.querySelectorAll('form textarea, form input[type="text"]:not([readonly]):not([data-guest-name])')].some(
    (field) => field.value.trim() !== '' && field.value !== field.defaultValue,
  );
}

function showReloadNotice(message) {
  if (document.querySelector('.draft-notice')) return;
  const notice = document.createElement('div');
  notice.className = 'draft-notice';
  notice.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = message;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button button--small';
  button.textContent = '読み込み直す';
  button.addEventListener('click', () => location.reload());
  notice.append(text, button);
  document.body.append(notice);
}

// --- Waiting for the routine: poll the thread status and reload on change ---
function startPolling() {
  const url = document.body.dataset.pollUrl;
  const signature = document.body.dataset.pollSignature;
  if (!url) return;
  const started = Date.now();
  let timer;
  const reload = (data) => {
    if (!hasDraft()) return location.reload();
    // Text being written stays; the page says that there is something new.
    if (data && data.latest_plan !== (document.body.dataset.latestPlan || null)) {
      // Comments go on the latest version only: those written on this one can no longer be sent.
      for (const form of document.querySelectorAll('form[action$="/comments"]')) {
        for (const button of form.querySelectorAll('button[type="submit"]')) {
          button.disabled = true;
          button.title = '計画書の新しい版が届いたため、この版にはコメントできません';
        }
      }
      return showReloadNotice('計画書の新しい版が届きました。書きかけのコメントは前の版には送れないため、内容を控えてから読み込み直し、新しい版に書いてください。');
    }
    showReloadNotice('Claude Code から新しい結果が届きました。書きかけの内容を送るか消してから、読み込み直してください。');
  };
  const schedule = () => {
    const elapsed = Date.now() - started;
    timer = setTimeout(check, elapsed < 5 * 60_000 ? 5_000 : 15_000);
  };
  const check = async () => {
    if (document.hidden) return schedule();
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (response.status === 401) return reload();
      if (response.ok) {
        const data = await response.json();
        if (data.signature !== signature) return reload(data);
      }
    } catch {
      // Try again on the next tick.
    }
    schedule();
  };
  schedule();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !document.querySelector('.draft-notice')) {
      clearTimeout(timer);
      check();
    }
  });
}

// --- Markdown fields: preview with the server's renderer ---
function setupMarkdownFields() {
  for (const field of document.querySelectorAll('[data-md-field]')) {
    const input = field.querySelector('[data-md-input]');
    const preview = field.querySelector('[data-md-preview]');
    const tabs = field.querySelectorAll('[data-md-tab]');
    const select = async (mode) => {
      for (const tab of tabs) {
        const active = tab.dataset.mdTab === mode;
        tab.classList.toggle('is-active', active);
        tab.setAttribute('aria-selected', String(active));
      }
      if (mode === 'write') {
        preview.hidden = true;
        input.hidden = false;
        input.focus();
        return;
      }
      preview.style.minHeight = `${input.offsetHeight}px`;
      preview.innerHTML = '<p class="muted">表示を準備しています…</p>';
      input.hidden = true;
      preview.hidden = false;
      try {
        const response = await fetch(field.dataset.previewUrl || '/api/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ markdown: input.value }),
        });
        const { html } = await response.json();
        // The HTML comes from this app's Markdown renderer, which escapes raw HTML.
        preview.innerHTML = html || '<p class="muted">（入力がありません）</p>';
        enhance(preview);
      } catch {
        preview.innerHTML = '<p class="muted">プレビューを表示できませんでした。</p>';
      }
    };
    for (const tab of tabs) tab.addEventListener('click', () => select(tab.dataset.mdTab));
  }
}

// --- Copy buttons ---
async function copyText(button, text) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'コピーしました';
  } catch {
    button.textContent = 'コピーできませんでした';
  }
  setTimeout(() => (button.textContent = original), 1800);
}

function setupCopyButtons() {
  for (const button of document.querySelectorAll('[data-copy-url]')) {
    button.addEventListener('click', async () => {
      const response = await fetch(button.dataset.copyUrl, { cache: 'no-store' });
      copyText(button, await response.text());
    });
  }
  for (const button of document.querySelectorAll('[data-copy-text-from]')) {
    button.addEventListener('click', () => {
      const source = document.getElementById(button.dataset.copyTextFrom);
      copyText(button, source.value ?? source.textContent);
    });
  }
}

// --- The name a visitor of a share link posts under, remembered in this browser ---
const GUEST_NAME_KEY = 'maronn-planner.guest-name';
function fillGuestNames(root = document) {
  const fields = root.querySelectorAll('[data-guest-name]');
  if (fields.length === 0) return;
  let saved = '';
  try {
    saved = localStorage.getItem(GUEST_NAME_KEY) ?? '';
  } catch {
    // Storage may be unavailable (private mode); the name is then typed each time.
  }
  for (const field of fields) if (!field.value) field.value = saved;
}

function rememberGuestName(form) {
  const field = form.querySelector('[data-guest-name]');
  if (!field) return;
  try {
    localStorage.setItem(GUEST_NAME_KEY, field.value.trim());
  } catch {
    // See above.
  }
}

// --- Forms: confirmation and no double submits (each submit fires the routine) ---
// Delegated, so the comment forms the page adds later behave the same.
function setupForms() {
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.dataset.confirm && !confirm(form.dataset.confirm)) {
      event.preventDefault();
      return;
    }
    if (form.hasAttribute('data-submit-once')) {
      if (form.dataset.submitted) {
        event.preventDefault();
        return;
      }
      form.dataset.submitted = 'true';
      for (const button of form.querySelectorAll('button[type="submit"]')) {
        button.setAttribute('aria-busy', 'true');
        button.textContent = '送信しています…';
      }
    }
    rememberGuestName(form);
  });
}

// --- Comments in place on the latest plan ---
// The server marks the blocks of a plan (headings, paragraphs, list items,
// tables, code) with data-line, the line of the Markdown they start on, and
// shows the comments on each block right under it (.comment-thread). Here,
// pointing at a block of the latest version shows a button in its right
// margin, and selecting text shows "この部分にコメント"; both open the comment
// form under the block, with the block's line and the selected text. The text
// the open comments quote is highlighted.

/** The plan's own UI inside its body: the comments and the forms, which are not text of the plan. */
const NOT_PLAN_TEXT = '.comment-thread, .comment-form, template, style, script';

const elementOf = (node) => (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement ?? null);
const isPlanText = (node) => !elementOf(node)?.closest(NOT_PLAN_TEXT);

/** The block a node is in, if it is plan text of a commentable body. */
function blockOf(node) {
  const element = elementOf(node);
  if (!element || element.closest(NOT_PLAN_TEXT)) return null;
  const block = element.closest('[data-line]');
  return block?.closest('[data-plan-body][data-commentable]') ? block : null;
}

function describeBlock(block) {
  if (/^H[1-6]$/.test(block.tagName)) return `見出し「${block.textContent.trim()}」`;
  if (block.tagName === 'P') return '段落';
  if (block.tagName === 'LI') return 'リストの項目';
  if (block.tagName === 'PRE') return block.classList.contains('mermaid') ? '図' : 'コードブロック';
  if (block.classList.contains('table-wrap')) return '表';
  return 'この場所';
}

/** Where the comments on a block go, as on the server: after it, or for a list item before its nested list. */
function insertUnder(block, node) {
  if (block.tagName === 'LI') {
    const nested = [...block.children].find((child) => child.tagName === 'UL' || child.tagName === 'OL');
    block.insertBefore(node, nested ?? null);
  } else {
    block.after(node);
  }
}

/**
 * The text nodes of the plan in a body, with every character that is not
 * white space mapped to its node and offset. Quotes are matched without
 * white space, which selections and the DOM put in different places.
 */
function indexPlanText(body) {
  const chars = [];
  const nodes = [];
  const offsets = [];
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (isPlanText(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.data;
    for (let offset = 0; offset < text.length; offset++) {
      if (/\s/.test(text[offset])) continue;
      chars.push(text[offset]);
      nodes.push(node);
      offsets.push(offset);
    }
  }
  return { text: chars.join(''), nodes, offsets };
}

/** The range of a quote in the plan, preferring the place that ends in the comment's block. */
function findQuote(index, quote, block) {
  const needle = quote.replace(/\s+/g, '');
  if (needle === '') return null;
  let best = null;
  for (let at = index.text.indexOf(needle); at !== -1; at = index.text.indexOf(needle, at + 1)) {
    const end = at + needle.length - 1;
    const inBlock = block?.contains(index.nodes[end]);
    // Before the block (a selection that started in an earlier block) beats after it.
    const beforeBlock = block && !inBlock && block.compareDocumentPosition(index.nodes[end]) & Node.DOCUMENT_POSITION_PRECEDING;
    const rank = inBlock ? 3 : beforeBlock ? 2 : 1;
    if (!best || rank > best.rank || (rank === best.rank && rank === 2)) best = { at, end, rank };
    if (rank === 3) break;
  }
  if (!best) return null;
  const range = document.createRange();
  range.setStart(index.nodes[best.at], index.offsets[best.at]);
  range.setEnd(index.nodes[best.end], index.offsets[best.end] + 1);
  return range;
}

/**
 * What a selection says in the plan: its text without the comments it
 * crosses, the range from its first to its last character of plan text, and
 * the block of that last character, which the comment goes under.
 */
function readSelection(range, body) {
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (isPlanText(node) && range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  let text = '';
  let first = null;
  let last = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.data.length;
    const part = node.data.slice(start, end);
    text += part;
    const lead = part.search(/\S/);
    if (lead === -1) continue;
    first ??= { node, offset: start + lead };
    last = { node, offset: start + part.search(/\S\s*$/) + 1 };
  }
  if (!first || !last) return null;
  const block = blockOf(last.node);
  if (!block) return null;
  const exact = document.createRange();
  exact.setStart(first.node, first.offset);
  exact.setEnd(last.node, last.offset);
  return { text: text.replace(/[ \t]*\n[\s]*/g, '\n').replace(/[ \t]+/g, ' ').trim(), range: exact, block };
}

// CSS Custom Highlight API: marks text without changing the DOM. Without it, nothing is highlighted.
const highlights = 'highlights' in CSS && typeof Highlight === 'function' ? CSS.highlights : null;
function setHighlight(name, ranges) {
  if (!highlights) return;
  if (ranges.length === 0) highlights.delete(name);
  else highlights.set(name, new Highlight(...ranges));
}

/** Highlights the text the open comments of the latest plan quote; pointing at a comment marks its text more. */
function markQuotes() {
  const ranges = [];
  for (const body of document.querySelectorAll('[data-plan-body][data-commentable]')) {
    const index = indexPlanText(body);
    for (const thread of body.querySelectorAll('.comment-thread[data-thread-line]')) {
      const block = body.querySelector(`[data-line="${thread.dataset.threadLine}"]`);
      for (const comment of thread.querySelectorAll('.comment--open')) {
        const quote = comment.querySelector('[data-comment-quote-text]')?.textContent ?? '';
        const range = quote ? findQuote(index, quote, block) : null;
        if (!range) continue;
        ranges.push(range);
        comment.addEventListener('mouseenter', () => setHighlight('comment-quote-active', [range]));
        comment.addEventListener('mouseleave', () => setHighlight('comment-quote-active', []));
      }
    }
  }
  setHighlight('comment-quote', ranges);
}

/** The comment form under a block (one at a time). */
let draft = null;

function closeDraft() {
  if (!draft) return true;
  const body = draft.form.querySelector('[data-comment-body]');
  if (body.value.trim() !== '' && !confirm('書きかけのコメントを破棄しますか？')) return false;
  draft.form.remove();
  draft.block.classList.remove('is-comment-target');
  draft.addButton?.removeAttribute('hidden');
  setHighlight('comment-draft', []);
  draft = null;
  return true;
}

function openDraft(block, selection = null) {
  const body = block.closest('[data-plan-body]');
  const template = document.querySelector(`template[data-comment-template="${body.dataset.planBody}"]`);
  if (!template) return;
  if (draft?.block === block && !selection) {
    draft.form.querySelector('[data-comment-body]').focus();
    return;
  }
  if (!closeDraft()) return;

  const form = template.content.firstElementChild.cloneNode(true);
  form.querySelector('[data-comment-anchor]').value = block.dataset.line;
  const what = describeBlock(block);
  form.querySelector('[data-comment-target]').textContent = selection ? `${what}の、選択した部分へのコメント` : `${what}へのコメント`;
  if (selection) {
    const quote = form.querySelector('[data-comment-quote]');
    quote.value = selection.text.slice(0, 1000);
    const preview = form.querySelector('[data-comment-quote-preview]');
    preview.textContent = quote.value;
    preview.hidden = false;
    setHighlight('comment-draft', [selection.range]);
  }
  fillGuestNames(form);

  // Under the block's comments if it has some, otherwise right under the block.
  const thread = body.querySelector(`.comment-thread[data-thread-line="${block.dataset.line}"]`);
  const addButton = thread?.querySelector('[data-comment-add]') ?? null;
  if (thread) {
    addButton?.setAttribute('hidden', '');
    thread.append(form);
  } else {
    insertUnder(block, form);
  }
  block.classList.add('is-comment-target');
  draft = { form, block, addButton };

  const textarea = form.querySelector('[data-comment-body]');
  form.querySelector('[data-comment-cancel]').addEventListener('click', () => closeDraft());
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDraft();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  textarea.focus({ preventScroll: true });
  form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** The button in the right margin of the block under the pointer (or the block last tapped). */
function setupBlockButton() {
  const button = document.querySelector('[data-block-comment-button]');
  const bodies = document.querySelectorAll('[data-plan-body][data-commentable]');
  if (!button || bodies.length === 0) return;
  let current = null;

  const hide = () => {
    button.hidden = true;
    current?.classList.remove('is-comment-hover');
    current = null;
  };
  const show = (block, pointerY) => {
    if (draft?.block === block) return hide();
    if (current !== block) current?.classList.remove('is-comment-hover');
    current = block;
    const body = block.closest('[data-plan-body]');
    const rect = block.getBoundingClientRect();
    const right = body.getBoundingClientRect().right;
    button.hidden = false;
    // Next to the block's first line, or next to the pointer when that line is scrolled away.
    const size = button.offsetHeight || 28;
    const top = rect.top >= 0 ? rect.top - 2 : Math.min(Math.max(pointerY - size / 2, 8), rect.bottom - size);
    button.style.top = `${window.scrollY + top}px`;
    button.style.left = `${window.scrollX + right - size - 2}px`;
  };

  // Touch screens have no pointer to follow: a tap on a block shows its button, which stays until a tap elsewhere.
  let touch = false;
  document.addEventListener('pointerdown', (event) => {
    touch = event.pointerType !== 'mouse';
    if (!touch || button.contains(event.target)) return;
    const block = blockOf(event.target);
    if (block) show(block, event.clientY);
    else hide();
  });
  for (const body of bodies) {
    body.addEventListener('mouseover', (event) => {
      if (elementOf(event.target)?.closest(NOT_PLAN_TEXT)) return hide();
      const block = blockOf(event.target);
      if (block) show(block, event.clientY);
    });
    body.addEventListener('mousemove', (event) => {
      if (current && current.getBoundingClientRect().top < 0) show(current, event.clientY);
    });
    body.addEventListener('mouseleave', (event) => {
      if (!touch && !button.contains(event.relatedTarget)) hide();
    });
  }
  button.addEventListener('mouseleave', (event) => {
    if (!touch && ![...bodies].some((body) => body.contains(event.relatedTarget))) hide();
  });
  const mark = (on) => current?.classList.toggle('is-comment-hover', on);
  button.addEventListener('mouseenter', () => mark(true));
  button.addEventListener('focus', () => mark(true));
  button.addEventListener('blur', () => mark(false));
  button.addEventListener('click', () => {
    if (!current) return;
    const block = current;
    hide();
    openDraft(block);
  });
  window.addEventListener('resize', hide);
}

/** "この部分にコメント" under a selection in the latest plan. */
function setupSelectionButton() {
  const button = document.querySelector('[data-quote-button]');
  if (!button) return;
  let pending = null;
  let hideTimer;
  let pointerDown = false;

  const hide = () => {
    button.hidden = true;
    pending = null;
  };
  const update = () => {
    clearTimeout(hideTimer);
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return hide();
    const range = selection.getRangeAt(0);
    // A triple click can end the selection in the next element, outside the plan: its start says which plan.
    const bodyOf = (node) => elementOf(node)?.closest('[data-plan-body][data-commentable]');
    const body = bodyOf(range.commonAncestorContainer) ?? bodyOf(range.startContainer);
    const read = body ? readSelection(range, body) : null;
    if (!read || read.text === '') return hide();
    pending = read;
    const rects = read.range.getClientRects();
    const end = rects[rects.length - 1] ?? read.range.getBoundingClientRect();
    button.hidden = false;
    const width = button.offsetWidth;
    const left = Math.max(8, Math.min(end.right - width / 2, document.documentElement.clientWidth - width - 8));
    button.style.top = `${window.scrollY + end.bottom + 8}px`;
    button.style.left = `${window.scrollX + left}px`;
  };

  document.addEventListener('mousedown', (event) => {
    if (!button.contains(event.target)) pointerDown = true;
  });
  document.addEventListener('mouseup', () => {
    pointerDown = false;
    setTimeout(update, 0);
  });
  let changeTimer;
  document.addEventListener('selectionchange', () => {
    clearTimeout(changeTimer);
    if (window.getSelection()?.isCollapsed) {
      // A tap on the button can collapse the selection before the click arrives.
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, 400);
      return;
    }
    // Keyboard and touch selections end without a mouseup.
    if (!pointerDown) changeTimer = setTimeout(update, 250);
  });
  // Keep the selection when the button is pressed.
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => {
    if (!pending) return;
    const selection = pending;
    hide();
    openDraft(selection.block, selection);
    window.getSelection()?.removeAllRanges();
  });
}

/** "ここにコメントを追加" in the comments of a block. */
function setupAddButtons() {
  for (const button of document.querySelectorAll('[data-comment-add]')) {
    const body = button.closest('[data-plan-body][data-commentable]');
    const block = body?.querySelector(`[data-line="${button.dataset.commentAdd}"]`);
    if (!block) continue;
    button.hidden = false;
    button.addEventListener('click', () => openDraft(block));
  }
}

// --- Links to a comment: open what hides it (a folded version, resolved comments) ---
const loadedAt = performance.now();
let userScrolled = false;
for (const type of ['wheel', 'touchmove', 'keydown']) addEventListener(type, () => (userScrolled = true), { once: true, passive: true });

function revealHashTarget({ force = false } = {}) {
  const id = decodeURIComponent(location.hash.slice(1));
  const target = id ? document.getElementById(id) : null;
  if (!target) return;
  let opened = false;
  for (let element = target.parentElement; element; element = element.parentElement) {
    if (element.tagName === 'DETAILS' && !element.open) {
      element.open = true;
      opened = true;
    }
  }
  if (opened || force) target.scrollIntoView({ block: target.classList.contains('comment') ? 'center' : 'start' });
}

setupForms();
fillGuestNames();
startPolling();
setupCollapsedVersions();
setupMarkdownFields();
setupCopyButtons();
setupBlockButton();
setupSelectionButton();
setupAddButtons();
revealHashTarget();
addEventListener('hashchange', () => revealHashTarget());
enhance().then(() => {
  // Diagrams and highlighted code change the text and the height of the page:
  // mark the quotes now, and keep a linked comment in view if nobody scrolled.
  markQuotes();
  if (!userScrolled && performance.now() - loadedAt < 4_000) revealHashTarget({ force: true });
});
