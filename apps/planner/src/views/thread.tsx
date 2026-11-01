/** @jsxImportSource hono/jsx */
/**
 * The pages of one thread: the conversation with every version of the plan,
 * its comments and the forms, the editor of the plan, and the diff of two
 * versions. The same pages serve the owner (/plans/{id}) and the visitors of
 * the share link (/s/{token}); ThreadAccessView says which.
 */
import { raw } from 'hono/html';
import type { Child } from 'hono/jsx';
import type { CurrentUser } from '../auth/session.js';
import { LIMITS } from '../compose.js';
import { authorLabel, type CommentRow, type MessageRow, type RunRow, type ThreadRow } from '../db.js';
import type { Heading } from '../markdown.js';
import { describeSectionChanges, hasSectionChanges, type DiffHunk, type SectionChanges } from '../plan-diff.js';
import type { Question } from '../routine/callback.js';
import { Flash, formatDate, Layout, MarkdownField, StatusBadge } from './layout.js';

export interface ThreadAccessView {
  mode: 'owner' | 'guest';
  /** /plans/{id} or /s/{token}: where the forms of the page post to. */
  basePath: string;
  /** A visitor of the share link without a session: the forms ask for a name. */
  anonymous: boolean;
  /** The signed-in viewer owns the thread (also when they open its share link). */
  viewerIsOwner: boolean;
  viewerSub: string | null;
}

export interface CommentView {
  comment: CommentRow;
  html: string;
  replyHtml: string | null;
}

export interface TimelineItem {
  message: MessageRow;
  html: string;
  headings: Heading[];
  questions: Question[];
  /** The latest run started for this user message. */
  run?: RunRow;
  /** Plans: 1 for the first version, 2 for the next, and so on. */
  planVersion?: number;
  isLatest?: boolean;
  /** Plans after the first: the sections that differ from the previous version. */
  sectionChanges?: SectionChanges;
  /** The change summary of a plan or the notes of a prompt, rendered. */
  summaryHtml?: string;
  /** Plans: the comments on this version. */
  comments?: CommentView[];
  /** Prompt requests and implementation prompts: the plan version they are about. */
  basePlanVersion?: number;
}

export interface ThreadViewModel {
  thread: ThreadRow;
  items: TimelineItem[];
  activeRun: RunRow | null;
  latestRun: RunRow | null;
  pendingQuestions: TimelineItem | null;
  latestPlan: TimelineItem | null;
  openComments: CommentRow[];
  progressHtml: string | null;
  signature: string;
}

const RUN_STATUS_LABELS: Record<RunRow['status'], string> = {
  firing: 'ルーチンを起動中',
  running: 'Claude Code が作業中',
  completed: '完了',
  failed: '失敗',
  expired: '時間切れ',
};

const WORKING_LABELS: Record<RunRow['task'], string> = {
  plan: 'Claude Code がリポジトリを調べて計画を作っています',
  implementation_prompt: 'Claude Code が計画書を実装用プロンプトに整形しています',
};

function who(message: MessageRow, access: ThreadAccessView): string {
  if (message.role === 'assistant') return 'Claude Code';
  if (access.viewerSub !== null && message.author_sub === access.viewerSub) return 'あなた';
  return authorLabel(message);
}

function RunInfo(props: { run: RunRow; isLatest: boolean; access: ThreadAccessView; canRetry: boolean }) {
  const { run } = props;
  return (
    <div class={`run-info run-info--${run.status}`}>
      <span class="run-info__status">{RUN_STATUS_LABELS[run.status]}</span>
      {run.session_url && props.access.mode === 'owner' ? (
        <a href={run.session_url} target="_blank" rel="noopener noreferrer">
          Claude Code のセッションを開く ↗
        </a>
      ) : null}
      {run.error ? <span class="run-info__error">{run.error}</span> : null}
      {props.isLatest && props.canRetry && (run.status === 'failed' || run.status === 'expired') ? (
        <form method="post" action={`${props.access.basePath}/retry`} class="inline-form" data-submit-once>
          <button type="submit" class="button button--small">
            もう一度依頼する
          </button>
        </form>
      ) : null}
    </div>
  );
}

function Toc(props: { headings: Heading[] }) {
  const headings = props.headings.filter((heading) => heading.level >= 2 && heading.level <= 3);
  if (headings.length < 3) return null;
  return (
    <details class="toc">
      <summary>目次</summary>
      <ol>
        {headings.map((heading) => (
          <li class={`toc__item toc__item--${heading.level}`}>
            <a href={`#${heading.id}`}>{heading.text}</a>
          </li>
        ))}
      </ol>
    </details>
  );
}

function MessageTools(props: { rawUrl: string; copyLabel?: string; children?: Child }) {
  return (
    <span class="message__tools">
      <button type="button" class="link-button" data-copy-url={props.rawUrl}>
        {props.copyLabel ?? 'Markdown をコピー'}
      </button>
      <a href={props.rawUrl} download>
        .md
      </a>
      {props.children}
    </span>
  );
}

function ChangeInfo(props: { item: TimelineItem; summaryLabel: string }) {
  const { item } = props;
  const sections = item.sectionChanges && hasSectionChanges(item.sectionChanges) ? item.sectionChanges : null;
  if (!item.summaryHtml && !sections) return null;
  return (
    <div class="change-info">
      {item.summaryHtml ? (
        <div class="change-info__row">
          <span class="change-info__label">{props.summaryLabel}</span>
          <div class="markdown-body change-info__text">{raw(item.summaryHtml)}</div>
        </div>
      ) : null}
      {sections ? (
        <div class="change-info__row">
          <span class="change-info__label">変わった節</span>
          <span class="change-info__text">{describeSectionChanges(sections)}</span>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Comments

function GuestNameField(props: { suffix: string }) {
  const id = `guest-name-${props.suffix}`;
  return (
    <div class="field field--name">
      <label for={id}>表示名（任意）</label>
      <input id={id} name="author_name" type="text" maxlength={LIMITS.name} placeholder="ゲスト" autocomplete="nickname" data-guest-name />
    </div>
  );
}

function CommentItem(props: { view: CommentView; access: ThreadAccessView; canComment: boolean }) {
  const { comment } = props.view;
  const resolved = comment.resolved_at !== null;
  const base = `${props.access.basePath}/comments/${comment.id}`;
  return (
    <li class={`comment ${resolved ? 'comment--resolved' : 'comment--open'}`} id={comment.id}>
      <div class="comment__head">
        <span class="comment__author">
          {props.access.viewerSub !== null && comment.author_sub === props.access.viewerSub ? 'あなた' : authorLabel(comment)}
        </span>
        <time class="muted" datetime={new Date(comment.created_at * 1000).toISOString()}>
          {formatDate(comment.created_at)}
        </time>
        {comment.section ? <span class="comment__section">§ {comment.section}</span> : null}
        <span class={`badge ${resolved ? 'badge--resolved' : 'badge--open'}`}>{resolved ? '解決済み' : '未解決'}</span>
      </div>
      {comment.quote ? <blockquote class="comment__quote">{comment.quote}</blockquote> : null}
      <div class="markdown-body comment__body">{raw(props.view.html)}</div>
      {props.view.replyHtml ? (
        <div class="comment__reply">
          <span class="comment__reply-author">Claude Code の返答</span>
          <div class="markdown-body">{raw(props.view.replyHtml)}</div>
        </div>
      ) : null}
      <div class="comment__foot">
        {resolved ? (
          <span class="muted">
            {comment.resolved_by === 'assistant'
              ? 'Claude Code が計画書に反映して解決'
              : `${comment.resolved_by_name ? `${comment.resolved_by_name} が` : ''}解決`}
            （{formatDate(comment.resolved_at!)}）
          </span>
        ) : null}
        {props.canComment ? (
          <form method="post" action={`${base}/${resolved ? 'reopen' : 'resolve'}`} class="inline-form">
            <button type="submit" class="link-button">
              {resolved ? '未解決に戻す' : '解決にする'}
            </button>
          </form>
        ) : null}
        {props.access.mode === 'owner' ? (
          <form method="post" action={`${base}/delete`} class="inline-form" data-confirm="このコメントを削除します。よろしいですか？">
            <button type="submit" class="link-button link-button--danger">
              削除
            </button>
          </form>
        ) : null}
      </div>
    </li>
  );
}

function CommentForm(props: { item: TimelineItem; access: ThreadAccessView }) {
  const id = props.item.message.id;
  const sections = props.item.headings.filter((heading) => heading.level === 2);
  return (
    <form method="post" action={`${props.access.basePath}/comments`} class="comment-form" data-comment-form={id} data-submit-once>
      <input type="hidden" name="message_id" value={id} />
      <div class="comment-form__row">
        <div class="field">
          <label for={`comment-section-${id}`}>対象の節</label>
          <select id={`comment-section-${id}`} name="section" data-comment-section>
            <option value="">計画書全体</option>
            {sections.map((heading) => (
              <option value={heading.text}>{heading.text}</option>
            ))}
          </select>
        </div>
        {props.access.anonymous ? <GuestNameField suffix={`comment-${id}`} /> : null}
      </div>
      <div class="field">
        <label for={`comment-quote-${id}`}>引用（任意）</label>
        <textarea
          id={`comment-quote-${id}`}
          name="quote"
          rows={2}
          maxlength={LIMITS.quote}
          placeholder="計画書の文章を選択して「この部分にコメント」を押すと、ここに入ります"
          data-comment-quote
        ></textarea>
      </div>
      <div class="field">
        <label for={`comment-body-${id}`}>コメント</label>
        <textarea
          id={`comment-body-${id}`}
          name="body"
          rows={3}
          maxlength={LIMITS.comment}
          required
          placeholder="例：UC-2 のエラー応答は RFC 9449 §7.1 の形にしてほしい"
          data-comment-body
        ></textarea>
        <p class="hint">未解決のコメントは、次に Claude Code へ送るときに計画書と一緒に渡ります。</p>
      </div>
      <div class="form-actions">
        <button type="submit" class="button button--small">
          コメントする
        </button>
      </div>
    </form>
  );
}

function CommentsSection(props: { item: TimelineItem; access: ThreadAccessView; withForm: boolean }) {
  const comments = props.item.comments ?? [];
  const open = comments.filter((view) => view.comment.resolved_at === null).length;
  if (comments.length === 0 && !props.withForm) return null;
  return (
    <section class="comments" aria-label={`計画書 v${props.item.planVersion} へのコメント`}>
      <h3 class="comments__title">
        コメント{' '}
        <span class="muted">
          未解決 {open} 件 / 全 {comments.length} 件
        </span>
      </h3>
      {comments.length > 0 ? (
        <ol class="comment-list">
          {comments.map((view) => (
            <CommentItem view={view} access={props.access} canComment={true} />
          ))}
        </ol>
      ) : null}
      {props.withForm ? <CommentForm item={props.item} access={props.access} /> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Messages

function planLabel(item: TimelineItem): string {
  const edited = item.message.role === 'user' ? '（編集）' : '';
  return `計画書 v${item.planVersion ?? 1}${edited}${item.isLatest ? '・最新' : ''}`;
}

function PlanCard(props: { item: TimelineItem; access: ThreadAccessView; latestPlanVersion: number; running: boolean }) {
  const { item, access } = props;
  const { message } = item;
  const version = item.planVersion ?? 1;
  const rawUrl = `${access.basePath}/messages/${message.id}.md`;
  const tools = (
    <MessageTools rawUrl={rawUrl}>
      {version > 1 ? <a href={`${access.basePath}/versions/${version}/diff`}>v{version - 1} との差分</a> : null}
      {item.isLatest && access.mode === 'owner' && !props.running ? (
        <a class="button button--small button--ghost" href={`${access.basePath}/plan/edit`}>
          編集する
        </a>
      ) : null}
    </MessageTools>
  );
  const body = (
    <>
      {message.title ? <p class="message__title">{message.title}</p> : null}
      <ChangeInfo item={item} summaryLabel={message.role === 'user' ? '編集メモ' : '変更点'} />
      <Toc headings={item.headings} />
      <div class="markdown-body plan-body" data-plan-body={message.id}>
        {raw(item.html)}
      </div>
      <CommentsSection item={item} access={access} withForm={item.isLatest === true} />
    </>
  );
  const head = (
    <header class="message__head">
      <span class="message__author">{who(message, access)}</span>
      <span class="message__kind">{planLabel(item)}</span>
      <time class="muted" datetime={new Date(message.created_at * 1000).toISOString()}>
        {formatDate(message.created_at)}
      </time>
      {tools}
    </header>
  );
  const classes = `message message--${message.role} message--plan${item.isLatest ? ' is-latest' : ''}`;
  if (item.isLatest) {
    return (
      <article class={classes} id={message.id}>
        {head}
        {body}
      </article>
    );
  }
  const open = (item.comments ?? []).filter((view) => view.comment.resolved_at === null).length;
  return (
    <details class={`${classes} message--collapsed`} id={message.id}>
      <summary class="message__summary">
        <span class="message__kind">{planLabel(item)}</span>
        <span class="message__author">{who(message, access)}</span>
        <span class="muted">{formatDate(message.created_at)}</span>
        {open > 0 ? <span class="badge badge--open">未解決のコメント {open}</span> : null}
        <span class="muted message__summary-hint">最新は v{props.latestPlanVersion}。開いて読む</span>
      </summary>
      <div class="message__collapsed-body">
        {head}
        {body}
      </div>
    </details>
  );
}

function PromptCard(props: { item: TimelineItem; access: ThreadAccessView; latestPlanVersion: number }) {
  const { item, access } = props;
  const { message } = item;
  const rawUrl = `${access.basePath}/messages/${message.id}.md`;
  const outdated = item.basePlanVersion !== undefined && item.basePlanVersion !== props.latestPlanVersion;
  const label = `実装用プロンプト${item.basePlanVersion ? `（計画書 v${item.basePlanVersion} から）` : ''}`;
  const content = (
    <>
      <header class="message__head">
        <span class="message__author">Claude Code</span>
        <span class="message__kind">{label}</span>
        <time class="muted" datetime={new Date(message.created_at * 1000).toISOString()}>
          {formatDate(message.created_at)}
        </time>
        <MessageTools rawUrl={rawUrl} copyLabel="プロンプトをコピー" />
      </header>
      {outdated ? (
        <p class="notice">
          このプロンプトは計画書 v{item.basePlanVersion} から作りました。最新の計画書は v{props.latestPlanVersion} です。
        </p>
      ) : null}
      {message.title ? <p class="message__title">{message.title}</p> : null}
      <ChangeInfo item={item} summaryLabel="整形メモ" />
      <div class="markdown-body prompt-body">{raw(item.html)}</div>
    </>
  );
  if (item.isLatest) {
    return (
      <article class="message message--assistant message--implementation_prompt is-latest" id={message.id}>
        {content}
      </article>
    );
  }
  return (
    <details class="message message--assistant message--implementation_prompt message--collapsed" id={message.id}>
      <summary class="message__summary">
        <span class="message__kind">{label}</span>
        <span class="muted">{formatDate(message.created_at)}</span>
        <span class="muted message__summary-hint">以前に作ったプロンプト。開いて読む</span>
      </summary>
      <div class="message__collapsed-body">{content}</div>
    </details>
  );
}

const USER_KIND_LABELS: Partial<Record<MessageRow['kind'], string>> = {
  request: '依頼',
  reply: '回答・追加の指示',
  prompt_request: '実装用プロンプトの依頼',
};

function MessageCard(props: { item: TimelineItem; access: ThreadAccessView; isLatestRun: boolean; canRetry: boolean }) {
  const { message } = props.item;
  const fromUser = message.role === 'user';
  const base = fromUser ? (USER_KIND_LABELS[message.kind] ?? '発言') : message.kind === 'questions' ? '質問' : 'エラー';
  const label = message.kind === 'prompt_request' && props.item.basePlanVersion ? `${base}（計画書 v${props.item.basePlanVersion}）` : base;
  const rawUrl = `${props.access.basePath}/messages/${message.id}.md`;
  return (
    <article class={`message message--${message.role} message--${message.kind}`} id={message.id}>
      <header class="message__head">
        <span class="message__author">{who(message, props.access)}</span>
        <span class="message__kind">{label}</span>
        <time class="muted" datetime={new Date(message.created_at * 1000).toISOString()}>
          {formatDate(message.created_at)}
        </time>
        <MessageTools rawUrl={rawUrl} />
      </header>
      {message.title && !fromUser ? <p class="message__title">{message.title}</p> : null}
      <div class="markdown-body">{raw(props.item.html)}</div>
      {props.item.questions.length > 0 ? (
        <ol class="question-list">
          {props.item.questions.map((question) => (
            <li>
              <span class="question-list__id">{question.id}</span> {question.question}
              {question.choices?.length ? <span class="muted">（選択肢: {question.choices.join(' / ')}）</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {props.item.run ? (
        <RunInfo run={props.item.run} isLatest={props.isLatestRun} access={props.access} canRetry={props.canRetry} />
      ) : null}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Forms

function AnswerForm(props: { access: ThreadAccessView; questions: Question[]; openComments: number }) {
  return (
    <form method="post" action={`${props.access.basePath}/messages`} class="stack reply-form" data-submit-once>
      <h2>質問に回答する</h2>
      {props.questions.map((question, index) => (
        <fieldset class="answer">
          <legend>
            <span class="question-list__id">{question.id}</span> {question.question}
          </legend>
          {question.choices?.length ? (
            <div class="choices">
              {question.choices.map((choice) => (
                <label class="choice">
                  <input type="radio" name={`choice.${question.id}`} value={choice} />
                  <span>{choice}</span>
                </label>
              ))}
            </div>
          ) : null}
          <textarea
            name={`answer.${question.id}`}
            rows={3}
            aria-label={`${question.id} への回答`}
            placeholder={question.choices?.length ? '補足（任意）' : '回答'}
            autofocus={index === 0 && !question.choices?.length}
          ></textarea>
        </fieldset>
      ))}
      <MarkdownField name="message" label="ほかに伝えること（任意）" rows={4} previewUrl={`${props.access.basePath}/preview`} />
      {props.openComments > 0 ? <p class="hint">未解決のコメント {props.openComments} 件も一緒に Claude Code へ渡ります。</p> : null}
      {props.access.anonymous ? <GuestNameField suffix="answer" /> : null}
      <div class="form-actions">
        <button type="submit" class="button">
          回答を送って計画を作り直す
        </button>
      </div>
    </form>
  );
}

function FollowUpForm(props: { access: ThreadAccessView; hasPlan: boolean; openComments: number }) {
  const withComments = props.openComments > 0;
  return (
    <form method="post" action={`${props.access.basePath}/messages`} class="stack reply-form" data-submit-once>
      <h2>{props.hasPlan ? '計画を直してもらう' : '追加で伝える'}</h2>
      <MarkdownField
        name="message"
        label={props.hasPlan ? '修正・追加してほしい点' : 'メッセージ'}
        rows={6}
        required={!withComments}
        placeholder={props.hasPlan ? '例：テスト計画に E2E のケースを足してほしい / Express の生成コードも対象にしたい' : ''}
        previewUrl={`${props.access.basePath}/preview`}
        hint={
          withComments
            ? `未解決のコメント ${props.openComments} 件も一緒に Claude Code へ渡ります。メッセージが空なら、コメントの反映だけを頼みます。`
            : undefined
        }
      />
      {props.access.anonymous ? <GuestNameField suffix="follow-up" /> : null}
      <div class="form-actions">
        <button type="submit" class="button">
          Claude Code に送る
        </button>
      </div>
    </form>
  );
}

function PromptForm(props: { access: ThreadAccessView; plan: TimelineItem; openComments: number }) {
  return (
    <form method="post" action={`${props.access.basePath}/prompt`} class="stack reply-form prompt-form" data-submit-once>
      <h2>実装用プロンプトを作る</h2>
      <p class="muted">
        計画書 v{props.plan.planVersion} を、Claude Code などの生成 AI にそのまま渡せる実装の指示に整形します。整形は Claude Code
        が行い、計画書の中身は変えません。
      </p>
      {props.openComments > 0 ? (
        <p class="notice">
          未解決のコメントが {props.openComments} 件あります。コメントは計画書に反映されていないため、プロンプトには「判断に迷ったとき」の注意点としてだけ入ります。反映したい場合は、先に「計画を直してもらう」から送ってください。
        </p>
      ) : null}
      <input type="hidden" name="base" value={props.plan.message.id} />
      <MarkdownField
        name="instructions"
        label="整形の指示（任意）"
        rows={3}
        maxlength={LIMITS.instructions}
        placeholder="例：Codex 向けに英語で書いて / 1 つのプルリクエストに収まる作業手順にして"
        previewUrl={`${props.access.basePath}/preview`}
      />
      {props.access.anonymous ? <GuestNameField suffix="prompt" /> : null}
      <div class="form-actions">
        <button type="submit" class="button">
          実装用プロンプトを作る
        </button>
      </div>
    </form>
  );
}

function SharePanel(props: { thread: ThreadRow; basePath: string; shareUrl: string | null; open: boolean }) {
  return (
    <details class="share-panel" open={props.open}>
      <summary class="button button--ghost">{props.shareUrl ? '共有中' : '共有'}</summary>
      <div class="share-panel__body">
        {props.shareUrl ? (
          <>
            <p>
              この URL を知っている人は、ログインせずにこのスレッドを閲覧し、メッセージの投稿（Claude Code の起動）とコメントができます。計画書の編集とスレッドの削除はできません。
            </p>
            <div class="copy-field">
              <input id="share-url" type="text" readonly value={props.shareUrl} aria-label="共有リンク" />
              <button type="button" class="button button--small" data-copy-text-from="share-url">
                コピー
              </button>
            </div>
            <div class="share-panel__actions">
              <form
                method="post"
                action={`${props.basePath}/share/rotate`}
                class="inline-form"
                data-confirm="今の URL は使えなくなります。共有リンクを作り直しますか？"
              >
                <button type="submit" class="button button--small button--ghost">
                  URL を作り直す
                </button>
              </form>
              <form method="post" action={`${props.basePath}/share/delete`} class="inline-form" data-confirm="共有をやめます。今の URL は使えなくなります。">
                <button type="submit" class="button button--small button--danger-ghost">
                  共有をやめる
                </button>
              </form>
            </div>
          </>
        ) : (
          <>
            <p>
              共有リンクを作ると、URL を知っている人はログインせずにこのスレッドを閲覧し、メッセージの投稿とコメントができます。投稿で起動したルーチンは、あなたの
              1 時間あたりの上限に数えます。
            </p>
            <form method="post" action={`${props.basePath}/share`} class="inline-form">
              <button type="submit" class="button button--small">
                共有リンクを作る
              </button>
            </form>
          </>
        )}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// The thread page

export function ThreadPage(props: {
  access: ThreadAccessView;
  user: CurrentUser | null;
  view: ThreadViewModel;
  shareUrl: string | null;
  error?: string | null;
  notice?: string | null;
  openSharePanel?: boolean;
}) {
  const { access, view } = props;
  const { thread } = view;
  const running = view.activeRun !== null;
  const latestPlanVersion = view.latestPlan?.planVersion ?? 0;
  const owner = access.mode === 'owner';
  return (
    <Layout
      title={thread.title}
      user={props.user}
      wide
      {...(owner ? {} : { headerNote: '共有リンクで表示中' })}
      bodyAttributes={running ? { 'data-poll-url': `${access.basePath}/status`, 'data-poll-signature': view.signature } : {}}
    >
      <div class="page-head">
        <div>
          {owner ? (
            <p class="crumbs">
              <a href="/">計画一覧</a> /
            </p>
          ) : null}
          <h1>{thread.title}</h1>
          <p class="meta">
            <StatusBadge status={thread.status} />
            <span class="muted">作成 {formatDate(thread.created_at)}</span>
            {!owner && thread.owner_name ? <span class="muted">作成者 {thread.owner_name}</span> : null}
            {view.openComments.length > 0 ? <span class="badge badge--open">未解決のコメント {view.openComments.length}</span> : null}
          </p>
        </div>
        <div class="page-head__actions">
          {owner ? <SharePanel thread={thread} basePath={access.basePath} shareUrl={props.shareUrl} open={props.openSharePanel === true} /> : null}
          {view.latestPlan ? (
            <a class="button button--ghost" href={`${access.basePath}/plan.md`} download>
              最新の計画書をダウンロード
            </a>
          ) : null}
          {owner ? (
            <form method="post" action={`${access.basePath}/delete`} class="inline-form" data-confirm="このスレッドを削除します。よろしいですか？">
              <button type="submit" class="button button--danger-ghost">
                削除
              </button>
            </form>
          ) : null}
        </div>
      </div>

      {!owner ? (
        <Flash kind="info">
          共有リンクで表示しています。ここでの投稿とコメントは、この URL を知っている全員が見られます。投稿すると Claude Code が作業を始めます。
          {access.viewerIsOwner ? (
            <>
              {' '}
              あなたはこのスレッドの作成者です。<a href={`/plans/${thread.id}`}>作成者の画面で開く</a>
            </>
          ) : null}
        </Flash>
      ) : null}
      {props.error ? <Flash kind="error">{props.error}</Flash> : null}
      {props.notice ? <Flash kind="info">{props.notice}</Flash> : null}

      <div class="timeline">
        {view.items.map((item) =>
          item.message.kind === 'plan' ? (
            <PlanCard item={item} access={access} latestPlanVersion={latestPlanVersion} running={running} />
          ) : item.message.kind === 'implementation_prompt' ? (
            <PromptCard item={item} access={access} latestPlanVersion={latestPlanVersion} />
          ) : (
            <MessageCard
              item={item}
              access={access}
              isLatestRun={item.run !== undefined && item.run.id === view.latestRun?.id}
              canRetry={!running}
            />
          ),
        )}
        {view.activeRun ? (
          <div class="working" role="status" aria-live="polite">
            <span class="spinner" aria-hidden="true"></span>
            <div>
              <p class="working__title">{WORKING_LABELS[view.activeRun.task]}</p>
              {view.progressHtml ? <div class="markdown-body working__progress">{raw(view.progressHtml)}</div> : null}
              <p class="muted">
                結果が届くとこのページは自動で更新されます。
                {view.activeRun.session_url && owner ? (
                  <>
                    {' '}
                    <a href={view.activeRun.session_url} target="_blank" rel="noopener noreferrer">
                      作業の様子を Claude Code で見る ↗
                    </a>
                  </>
                ) : null}
              </p>
            </div>
          </div>
        ) : null}
      </div>

      {!running ? (
        <div class="forms">
          {view.pendingQuestions ? (
            <AnswerForm access={access} questions={view.pendingQuestions.questions} openComments={view.openComments.length} />
          ) : (
            <FollowUpForm access={access} hasPlan={view.latestPlan !== null} openComments={view.openComments.length} />
          )}
          {view.latestPlan ? <PromptForm access={access} plan={view.latestPlan} openComments={view.openComments.length} /> : null}
        </div>
      ) : null}
      <button type="button" class="quote-button button button--small" data-quote-button hidden>
        この部分にコメント
      </button>
    </Layout>
  );
}

// ---------------------------------------------------------------------------
// Editing the plan

export function EditPlanPage(props: {
  user: CurrentUser;
  thread: ThreadRow;
  basePath: string;
  plan: { id: string; version: number };
  markdown: string;
  note: string;
  openComments: { comment: CommentRow; planVersion: number }[];
  resolve: string[];
  error?: string | null;
}) {
  const next = props.plan.version + 1;
  return (
    <Layout title={`計画書を編集（${props.thread.title}）`} user={props.user} wide>
      <p class="crumbs">
        <a href="/">計画一覧</a> / <a href={props.basePath}>{props.thread.title}</a> /
      </p>
      <h1>計画書を編集する</h1>
      <p class="lead">
        計画書 v{props.plan.version} を元に編集し、v{next} として保存します。保存した版が最新版になり、次に Claude Code
        へ送るときは、この版と、あなたが変えた箇所の差分を元に作業します。
      </p>
      {props.error ? <Flash kind="error">{props.error}</Flash> : null}
      <form method="post" action={`${props.basePath}/plan`} class="stack" data-submit-once>
        <input type="hidden" name="base" value={props.plan.id} />
        <MarkdownField name="markdown" label="計画書（Markdown）" rows={30} required value={props.markdown} maxlength={200_000} monospace />
        <div class="field">
          <label for="note">変更内容のメモ（任意）</label>
          <input
            id="note"
            name="note"
            type="text"
            maxlength={LIMITS.editNote}
            value={props.note}
            placeholder="例：テスト計画に E2E のケースを足した"
          />
          <p class="hint">版の履歴に残り、Claude Code にも変更の経緯として渡ります。</p>
        </div>
        {props.openComments.length > 0 ? (
          <fieldset class="answer">
            <legend>この編集で対応したコメント（解決にする）</legend>
            <ul class="resolve-list">
              {props.openComments.map(({ comment, planVersion }) => (
                <li>
                  <label class="resolve-item">
                    <input type="checkbox" name="resolve" value={comment.id} checked={props.resolve.includes(comment.id)} />
                    <span>
                      <span class="muted">
                        v{planVersion}
                        {comment.section ? ` § ${comment.section}` : ''}・{authorLabel(comment)}：
                      </span>
                      {comment.body.length > 160 ? `${comment.body.slice(0, 160)}…` : comment.body}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        ) : null}
        <div class="form-actions">
          <a class="button button--ghost" href={props.basePath}>
            キャンセル
          </a>
          <button type="submit" class="button">
            v{next} として保存
          </button>
        </div>
      </form>
    </Layout>
  );
}

// ---------------------------------------------------------------------------
// The diff of two versions

export function DiffPage(props: {
  user: CurrentUser | null;
  guest: boolean;
  thread: ThreadRow;
  basePath: string;
  from: { version: number; author: string };
  to: { version: number; author: string; summary: string | null };
  hunks: DiffHunk[] | null;
  sectionChanges: SectionChanges;
}) {
  return (
    <Layout title={`計画書 v${props.from.version} と v${props.to.version} の差分`} user={props.user} wide {...(props.guest ? { headerNote: '共有リンクで表示中' } : {})}>
      <p class="crumbs">
        {props.guest ? null : (
          <>
            <a href="/">計画一覧</a> /{' '}
          </>
        )}
        <a href={props.basePath}>{props.thread.title}</a> /
      </p>
      <h1>
        計画書 v{props.from.version} → v{props.to.version} の差分
      </h1>
      <p class="lead">
        v{props.from.version}（{props.from.author}）から v{props.to.version}（{props.to.author}）への変更です。
      </p>
      <dl class="kv card">
        <dt>変わった節</dt>
        <dd>{describeSectionChanges(props.sectionChanges)}</dd>
        {props.to.summary ? (
          <>
            <dt>変更点</dt>
            <dd>{props.to.summary}</dd>
          </>
        ) : null}
      </dl>
      {props.hunks === null ? (
        <Flash kind="info">差分が大きすぎるため、行ごとの表示を省きました。それぞれの版の Markdown を見比べてください。</Flash>
      ) : props.hunks.length === 0 ? (
        <Flash kind="info">2 つの版の本文は同じです。</Flash>
      ) : (
        <div class="diff" role="region" aria-label="差分">
          {props.hunks.map((hunk) => (
            <div class="diff__hunk">
              <div class="diff__header">{hunk.header}</div>
              {hunk.lines.map((line) => (
                <div class={`diff__line diff__line--${line.op === '+' ? 'add' : line.op === '-' ? 'del' : 'ctx'}`}>
                  <span class="diff__op" aria-hidden="true">
                    {line.op}
                  </span>
                  <span class="diff__text">{line.line === '' ? ' ' : line.line}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Layout>
  );
}
