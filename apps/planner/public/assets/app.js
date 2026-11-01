// maronn Planner — browser behavior: waiting for Claude Code, diagrams,
// code highlighting, Markdown preview, copying, comments on a selection of
// the plan, and the name of a visitor of a share link.

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

function enhance(root = document) {
  renderDiagrams(root);
  highlight(root);
}

function setupCollapsedVersions() {
  for (const details of document.querySelectorAll('details.message--collapsed')) {
    details.addEventListener('toggle', () => {
      if (details.open) enhance(details);
    });
  }
}

// --- Waiting for the routine: poll the thread status and reload on change ---
function startPolling() {
  const url = document.body.dataset.pollUrl;
  const signature = document.body.dataset.pollSignature;
  if (!url) return;
  const started = Date.now();
  let timer;
  const schedule = () => {
    const elapsed = Date.now() - started;
    timer = setTimeout(check, elapsed < 5 * 60_000 ? 5_000 : 15_000);
  };
  const check = async () => {
    if (document.hidden) return schedule();
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (response.status === 401) return location.reload();
      if (response.ok) {
        const data = await response.json();
        if (data.signature !== signature) {
          location.reload();
          return;
        }
      }
    } catch {
      // Try again on the next tick.
    }
    schedule();
  };
  schedule();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
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

// --- Forms: confirmation and no double submits (each submit fires the routine) ---
function setupForms() {
  for (const form of document.querySelectorAll('form[data-confirm]')) {
    form.addEventListener('submit', (event) => {
      if (!confirm(form.dataset.confirm)) event.preventDefault();
    });
  }
  for (const form of document.querySelectorAll('form[data-submit-once]')) {
    form.addEventListener('submit', (event) => {
      if (form.dataset.submitted) {
        event.preventDefault();
        return;
      }
      form.dataset.submitted = 'true';
      for (const button of form.querySelectorAll('button[type="submit"]')) {
        button.setAttribute('aria-busy', 'true');
        button.textContent = '送信しています…';
      }
    });
  }
}

// --- Comments on a selection of the plan ---
// Selecting text in the latest plan shows a button that puts the selection
// into the comment form as the quote, with the section it is in.
function setupQuoteComments() {
  const button = document.querySelector('[data-quote-button]');
  if (!button) return;
  let pending = null;

  const hide = () => {
    button.hidden = true;
    pending = null;
  };

  const sectionOf = (body, node) => {
    let block = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (block && block.parentElement !== body) block = block.parentElement;
    for (let element = block; element; element = element.previousElementSibling) {
      if (element.tagName === 'H2') return element.textContent.trim();
    }
    return '';
  };

  const update = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return hide();
    const range = selection.getRangeAt(0);
    const start = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
    const body = start?.closest('[data-plan-body]');
    const end = range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer : range.endContainer.parentElement;
    const form = body && document.querySelector(`[data-comment-form="${body.dataset.planBody}"]`);
    const text = selection.toString().trim();
    if (!body || !form || !end || !body.contains(end) || text === '') return hide();
    pending = { form, text, section: sectionOf(body, range.startContainer) };
    const rect = range.getBoundingClientRect();
    button.hidden = false;
    button.style.top = `${window.scrollY + rect.bottom + 6}px`;
    button.style.left = `${Math.max(8, Math.min(window.scrollX + rect.left, window.scrollX + document.documentElement.clientWidth - button.offsetWidth - 8))}px`;
  };

  document.addEventListener('mouseup', () => setTimeout(update, 0));
  document.addEventListener('keyup', (event) => {
    if (event.key.startsWith('Arrow') || event.key === 'Shift') update();
  });
  document.addEventListener('selectionchange', () => {
    if (window.getSelection()?.isCollapsed) hide();
  });
  // Keep the selection when the button is pressed.
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => {
    if (!pending) return;
    const { form, text, section } = pending;
    const quote = form.querySelector('[data-comment-quote]');
    quote.value = text.slice(0, Number(quote.getAttribute('maxlength')) || 1000);
    const select = form.querySelector('[data-comment-section]');
    if (select && [...select.options].some((option) => option.value === section)) select.value = section;
    hide();
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    form.querySelector('[data-comment-body]')?.focus({ preventScroll: true });
  });
}

// --- The name a visitor of a share link posts under, remembered in this browser ---
const GUEST_NAME_KEY = 'maronn-planner.guest-name';
function setupGuestNames() {
  const fields = document.querySelectorAll('[data-guest-name]');
  if (fields.length === 0) return;
  let saved = '';
  try {
    saved = localStorage.getItem(GUEST_NAME_KEY) ?? '';
  } catch {
    // Storage may be unavailable (private mode); the name is then typed each time.
  }
  for (const field of fields) {
    if (!field.value) field.value = saved;
    field.form?.addEventListener('submit', () => {
      try {
        localStorage.setItem(GUEST_NAME_KEY, field.value.trim());
      } catch {
        // See above.
      }
    });
  }
}

enhance();
startPolling();
setupCollapsedVersions();
setupMarkdownFields();
setupCopyButtons();
setupForms();
setupQuoteComments();
setupGuestNames();
