/** @jsxImportSource hono/jsx */
import type { Child } from 'hono/jsx';
import { raw } from 'hono/html';
import type { CurrentUser } from '../auth/session.js';
import type { ThreadStatus } from '../db.js';

export const APP_NAME = 'maronn Planner';

const dateFormat = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDate(epochSeconds: number): string {
  return dateFormat.format(new Date(epochSeconds * 1000));
}

export function Layout(props: {
  title: string;
  user?: CurrentUser | null;
  /** Attributes for <body>, such as the polling URL of a running thread. */
  bodyAttributes?: Record<string, string>;
  wide?: boolean;
  /** Shown in the header instead of the menu, for a visitor of a share link. */
  headerNote?: string;
  children?: Child;
}) {
  return (
    <>
      {raw('<!DOCTYPE html>')}
      <html lang="ja">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="robots" content="noindex" />
          <title>{`${props.title} | ${APP_NAME}`}</title>
          <link rel="stylesheet" href="/assets/app.css" />
          <script type="module" src="/assets/app.js"></script>
        </head>
        <body {...(props.bodyAttributes ?? {})}>
          <header class="site-header">
            <div class="site-header__inner">
              <a class="brand" href="/">
                <span class="brand__mark" aria-hidden="true">
                  ◆
                </span>
                {APP_NAME}
              </a>
              {props.user ? (
                <nav class="site-nav" aria-label="メニュー">
                  <a href="/">計画一覧</a>
                  <a href="/plans/new">新しく依頼</a>
                  <a href="/setup">設定</a>
                  <form method="post" action="/auth/logout" class="inline-form">
                    <button type="submit" class="link-button" title={props.user.email ?? props.user.sub}>
                      ログアウト（{props.user.name ?? props.user.sub}）
                    </button>
                  </form>
                </nav>
              ) : props.headerNote ? (
                <span class="site-header__note">{props.headerNote}</span>
              ) : null}
            </div>
          </header>
          <main class={props.wide ? 'container container--wide' : 'container'}>{props.children}</main>
        </body>
      </html>
    </>
  );
}

const STATUS_LABELS: Record<ThreadStatus, string> = {
  running: 'Claude Code が作業中',
  awaiting_answer: '回答待ち',
  plan_ready: '計画書あり',
  failed: '失敗',
};

export function StatusBadge(props: { status: ThreadStatus }) {
  return <span class={`badge badge--${props.status}`}>{STATUS_LABELS[props.status]}</span>;
}

export function Flash(props: { kind: 'error' | 'info'; children?: Child }) {
  return (
    <div class={`flash flash--${props.kind}`} role={props.kind === 'error' ? 'alert' : 'status'}>
      {props.children}
    </div>
  );
}

/** A Markdown textarea with a preview tab rendered by the server's renderer. */
export function MarkdownField(props: {
  name: string;
  label: string;
  value?: string;
  rows?: number;
  required?: boolean;
  placeholder?: string;
  hint?: string;
  maxlength?: number;
  /** Where the preview is rendered: /api/preview for signed-in pages, the share link's own for visitors. */
  previewUrl?: string;
  /** Distinguishes two fields of the same name on one page. */
  idSuffix?: string;
  /** A monospace editor, for a whole plan with its code and diagrams. */
  monospace?: boolean;
}) {
  const id = `field-${props.name.replace(/[^A-Za-z0-9_-]/g, '-')}${props.idSuffix ? `-${props.idSuffix}` : ''}`;
  return (
    <div class="field md-field" data-md-field data-preview-url={props.previewUrl ?? '/api/preview'}>
      <div class="md-field__head">
        <label for={id}>{props.label}</label>
        <div class="md-field__tabs" role="tablist">
          <button type="button" role="tab" class="tab is-active" data-md-tab="write" aria-selected="true">
            編集
          </button>
          <button type="button" role="tab" class="tab" data-md-tab="preview" aria-selected="false">
            プレビュー
          </button>
        </div>
      </div>
      <textarea
        id={id}
        name={props.name}
        rows={props.rows ?? 8}
        required={props.required}
        placeholder={props.placeholder}
        maxlength={props.maxlength}
        class={props.monospace ? 'code-area' : undefined}
        data-md-input
      >
        {props.value ?? ''}
      </textarea>
      <div class="md-field__preview markdown-body" data-md-preview hidden></div>
      {props.hint ? <p class="hint">{props.hint}</p> : null}
    </div>
  );
}
