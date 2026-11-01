/** @jsxImportSource hono/jsx */
import { raw } from 'hono/html';
import type { CurrentUser } from '../auth/session.js';
import type { MessageRow, RunRow, ThreadRow } from '../db.js';
import type { Heading } from '../markdown.js';
import type { Question } from '../routine/callback.js';
import { Flash, formatDate, Layout, MarkdownField, StatusBadge } from './layout.js';

// ---------------------------------------------------------------------------
// Dashboard

export function DashboardPage(props: { user: CurrentUser; threads: ThreadRow[]; routineConfigured: boolean }) {
  return (
    <Layout title="計画一覧" user={props.user}>
      <div class="page-head">
        <div>
          <h1>実装計画</h1>
          <p class="lead">
            maronn-openid-connect に入れたい機能を書くと、Claude Code がリポジトリを読んで実装計画書を作ります。
          </p>
        </div>
        <a class="button" href="/plans/new">
          新しく依頼する
        </a>
      </div>
      {!props.routineConfigured ? (
        <Flash kind="error">
          ルーチンがまだ設定されていません。<a href="/setup">設定</a>の手順に沿って ROUTINE_FIRE_URL と ROUTINE_TOKEN を登録してください。
        </Flash>
      ) : null}
      {props.threads.length === 0 ? (
        <div class="empty">
          <p>まだ依頼はありません。</p>
          <p class="muted">「新しく依頼する」から、作りたい機能を書いてください。</p>
        </div>
      ) : (
        <ul class="thread-list">
          {props.threads.map((thread) => (
            <li>
              <a class="thread-card" href={`/plans/${thread.id}`}>
                <span class="thread-card__title">{thread.title}</span>
                <span class="thread-card__meta">
                  <StatusBadge status={thread.status} />
                  <span class="muted">更新 {formatDate(thread.updated_at)}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Layout>
  );
}

// ---------------------------------------------------------------------------
// New request

export interface NewPlanValues {
  title: string;
  feature: string;
  specs: string;
  notes: string;
}

export function NewPlanPage(props: { user: CurrentUser; values?: Partial<NewPlanValues>; error?: string | null }) {
  const values = props.values ?? {};
  return (
    <Layout title="新しく依頼する" user={props.user}>
      <h1>新しく依頼する</h1>
      <p class="lead">
        作りたい機能を書いてください。Markdown が使えます。不明点があれば、計画書の前に Claude Code から質問が届きます。
      </p>
      {props.error ? <Flash kind="error">{props.error}</Flash> : null}
      <form method="post" action="/plans" class="stack" data-submit-once>
        <div class="field">
          <label for="title">機能の名前</label>
          <input
            id="title"
            name="title"
            type="text"
            maxlength={120}
            required
            value={values.title ?? ''}
            placeholder="例：トークンエンドポイントでの DPoP 対応"
          />
        </div>
        <MarkdownField
          name="feature"
          label="作りたい機能"
          rows={10}
          required
          value={values.feature}
          placeholder={'例：\n- RFC 9449 の DPoP proof をトークンエンドポイントで検証したい\n- 発行するアクセストークンに cnf.jkt を入れたい'}
          hint="何を実現したいか、なぜ必要か、使い方のイメージを書くと計画の精度が上がります。"
        />
        <div class="field">
          <label for="specs">関連する仕様（任意）</label>
          <input
            id="specs"
            name="specs"
            type="text"
            maxlength={500}
            value={values.specs ?? ''}
            placeholder="例：RFC 9449, OpenID Connect Core 1.0 §3.1.3.7"
          />
        </div>
        <MarkdownField
          name="notes"
          label="前提・制約・補足（任意）"
          rows={5}
          value={values.notes}
          placeholder="例：まずは Hono の生成コードだけでよい / experimental パッケージに入れたい"
        />
        <div class="form-actions">
          <a class="button button--ghost" href="/">
            キャンセル
          </a>
          <button type="submit" class="button">
            Claude Code に依頼する
          </button>
        </div>
      </form>
    </Layout>
  );
}

// ---------------------------------------------------------------------------
// Thread

export interface TimelineItem {
  message: MessageRow;
  html: string;
  headings: Heading[];
  questions: Question[];
  /** The latest run started for this user message. */
  run?: RunRow;
  /** 1 for the first plan of the thread, 2 for the next, and so on. */
  planVersion?: number;
}

export interface ThreadPageProps {
  user: CurrentUser;
  thread: ThreadRow;
  items: TimelineItem[];
  activeRun: RunRow | null;
  latestRun: RunRow | null;
  pendingQuestions: TimelineItem | null;
  latestPlan: TimelineItem | null;
  progressHtml: string | null;
  error?: string | null;
  notice?: string | null;
  pollSignature: string;
}

const RUN_STATUS_LABELS: Record<RunRow['status'], string> = {
  firing: 'ルーチンを起動中',
  running: 'Claude Code が作業中',
  completed: '完了',
  failed: '失敗',
  expired: '時間切れ',
};

function RunInfo(props: { run: RunRow; isLatest: boolean; threadId: string; canRetry: boolean }) {
  const { run } = props;
  return (
    <div class={`run-info run-info--${run.status}`}>
      <span class="run-info__status">{RUN_STATUS_LABELS[run.status]}</span>
      {run.session_url ? (
        <a href={run.session_url} target="_blank" rel="noopener noreferrer">
          Claude Code のセッションを開く ↗
        </a>
      ) : null}
      {run.error ? <span class="run-info__error">{run.error}</span> : null}
      {props.isLatest && props.canRetry && (run.status === 'failed' || run.status === 'expired') ? (
        <form method="post" action={`/plans/${props.threadId}/retry`} class="inline-form" data-submit-once>
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

function MessageCard(props: { item: TimelineItem; threadId: string; isLatestRun: boolean; canRetry: boolean }) {
  const { message } = props.item;
  const fromUser = message.role === 'user';
  const label = fromUser
    ? message.kind === 'request'
      ? '依頼'
      : '回答・追加の指示'
    : message.kind === 'plan'
      ? `計画書 v${props.item.planVersion ?? 1}`
      : message.kind === 'questions'
        ? '質問'
        : 'エラー';
  const rawUrl = `/plans/${props.threadId}/messages/${message.id}.md`;
  return (
    <article class={`message message--${message.role} message--${message.kind}`} id={message.id}>
      <header class="message__head">
        <span class="message__author">{fromUser ? 'あなた' : 'Claude Code'}</span>
        <span class="message__kind">{label}</span>
        <time class="muted" datetime={new Date(message.created_at * 1000).toISOString()}>
          {formatDate(message.created_at)}
        </time>
        <span class="message__tools">
          <button type="button" class="link-button" data-copy-url={rawUrl}>
            Markdown をコピー
          </button>
          <a href={rawUrl} download>
            .md
          </a>
        </span>
      </header>
      {message.title && !fromUser ? <p class="message__title">{message.title}</p> : null}
      {message.kind === 'plan' ? <Toc headings={props.item.headings} /> : null}
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
        <RunInfo run={props.item.run} isLatest={props.isLatestRun} threadId={props.threadId} canRetry={props.canRetry} />
      ) : null}
    </article>
  );
}

function AnswerForm(props: { threadId: string; questions: Question[] }) {
  return (
    <form method="post" action={`/plans/${props.threadId}/messages`} class="stack reply-form" data-submit-once>
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
      <MarkdownField name="message" label="ほかに伝えること（任意）" rows={4} />
      <div class="form-actions">
        <button type="submit" class="button">
          回答を送って計画を作り直す
        </button>
      </div>
    </form>
  );
}

function FollowUpForm(props: { threadId: string; hasPlan: boolean }) {
  return (
    <form method="post" action={`/plans/${props.threadId}/messages`} class="stack reply-form" data-submit-once>
      <h2>{props.hasPlan ? '計画を直してもらう' : '追加で伝える'}</h2>
      <MarkdownField
        name="message"
        label={props.hasPlan ? '修正・追加してほしい点' : 'メッセージ'}
        rows={6}
        required
        placeholder={props.hasPlan ? '例：テスト計画に E2E のケースを足してほしい / Express の生成コードも対象にしたい' : ''}
      />
      <div class="form-actions">
        <button type="submit" class="button">
          Claude Code に送る
        </button>
      </div>
    </form>
  );
}

export function ThreadPage(props: ThreadPageProps) {
  const { thread } = props;
  const running = props.activeRun !== null;
  const canPost = !running;
  return (
    <Layout
      title={thread.title}
      user={props.user}
      wide
      bodyAttributes={
        running
          ? { 'data-poll-url': `/plans/${thread.id}/status`, 'data-poll-signature': props.pollSignature }
          : {}
      }
    >
      <div class="page-head">
        <div>
          <p class="crumbs">
            <a href="/">計画一覧</a> /
          </p>
          <h1>{thread.title}</h1>
          <p class="meta">
            <StatusBadge status={thread.status} />
            <span class="muted">作成 {formatDate(thread.created_at)}</span>
          </p>
        </div>
        <div class="page-head__actions">
          {props.latestPlan ? (
            <a class="button button--ghost" href={`/plans/${thread.id}/plan.md`} download>
              最新の計画書をダウンロード
            </a>
          ) : null}
          <form method="post" action={`/plans/${thread.id}/delete`} class="inline-form" data-confirm="このスレッドを削除します。よろしいですか？">
            <button type="submit" class="button button--danger-ghost">
              削除
            </button>
          </form>
        </div>
      </div>

      {props.error ? <Flash kind="error">{props.error}</Flash> : null}
      {props.notice ? <Flash kind="info">{props.notice}</Flash> : null}

      <div class="timeline">
        {props.items.map((item) => (
          <MessageCard
            item={item}
            threadId={thread.id}
            isLatestRun={item.run !== undefined && item.run.id === props.latestRun?.id}
            canRetry={canPost}
          />
        ))}
        {props.activeRun ? (
          <div class="working" role="status" aria-live="polite">
            <span class="spinner" aria-hidden="true"></span>
            <div>
              <p class="working__title">Claude Code がリポジトリを調べて計画を作っています</p>
              {props.progressHtml ? <div class="markdown-body working__progress">{raw(props.progressHtml)}</div> : null}
              <p class="muted">
                結果が届くとこのページは自動で更新されます。
                {props.activeRun.session_url ? (
                  <>
                    {' '}
                    <a href={props.activeRun.session_url} target="_blank" rel="noopener noreferrer">
                      作業の様子を Claude Code で見る ↗
                    </a>
                  </>
                ) : null}
              </p>
            </div>
          </div>
        ) : null}
      </div>

      {canPost ? (
        props.pendingQuestions ? (
          <AnswerForm threadId={thread.id} questions={props.pendingQuestions.questions} />
        ) : (
          <FollowUpForm threadId={thread.id} hasPlan={props.latestPlan !== null} />
        )
      ) : null}
    </Layout>
  );
}

// ---------------------------------------------------------------------------
// Setup

export interface SetupStatus {
  appOrigin: string;
  issuer: string;
  clientId: string;
  routineConfigured: boolean;
  routineFireUrl: string | null;
  runsPerHourLimit: number;
  runTimeoutMinutes: number;
  allowedSubs: string[];
  routineBearerTokenConfigured: boolean;
  allowedDomains: string[];
  networkSecret: { name: string; secretType: string; allowedWebsite: string; header: { name: string; prefix: string } };
}

export function SetupPage(props: { user: CurrentUser; status: SetupStatus; prompt: string; promptHtml: string }) {
  const { status } = props;
  return (
    <Layout title="設定" user={props.user}>
      <h1>設定</h1>
      <p class="lead">Claude Code のルーチン（claude.ai/code/routines）と、このアプリをつなぐための設定です。</p>

      <section class="card">
        <h2>現在の設定</h2>
        <dl class="kv">
          <dt>アプリの URL（APP_ORIGIN）</dt>
          <dd>
            <code>{status.appOrigin}</code>
          </dd>
          <dt>IdP（OIDC_ISSUER）</dt>
          <dd>
            <code>{status.issuer}</code>（client_id: <code>{status.clientId}</code>）
          </dd>
          <dt>ルーチン</dt>
          <dd>
            {status.routineConfigured ? (
              <>
                <span class="badge badge--plan_ready">設定済み</span> <code>{maskFireUrl(status.routineFireUrl!)}</code>
              </>
            ) : (
              <span class="badge badge--failed">未設定</span>
            )}
          </dd>
          <dt>ルーチンの Bearer トークン（ROUTINE_BEARER_TOKEN_HASH）</dt>
          <dd>
            {status.routineBearerTokenConfigured ? (
              <span class="badge badge--plan_ready">設定済み</span>
            ) : (
              <span class="badge badge--failed">未設定（ルーチンの結果をすべて拒否します）</span>
            )}
          </dd>
          <dt>依頼の上限</dt>
          <dd>1 ユーザーあたり 1 時間に {status.runsPerHourLimit} 回、結果の待ち時間は最大 {status.runTimeoutMinutes} 分</dd>
          <dt>利用できるユーザー</dt>
          <dd>{status.allowedSubs.length > 0 ? status.allowedSubs.join(', ') : 'IdP にログインできる全員'}</dd>
        </dl>
      </section>

      <section class="card markdown-body">
        <h2>ルーチンの作り方</h2>
        <p>
          <code>pnpm run deploy</code> が同じ手順と値を表示します。環境の Network access と network secret、API
          トリガーのトークンは claude.ai の画面でしか設定できない（API や CLI が無い）ため、次の 1〜4 は claude.ai/code で行います。
        </p>
        <ol>
          <li>
            このルーチン専用の環境（Cloud environment）を作り、ネットワークアクセスを <strong>Custom</strong> にする。Allowed domains
            に下の「許可するドメイン」を 1 行に 1 つずつ入れ、「Also include default list of common package managers」も有効にする。
          </li>
          <li>
            同じ環境の <strong>Network secrets</strong> で <strong>Add secret</strong> を選び、Secret type を{' '}
            <strong>{status.networkSecret.secretType}</strong> にして、下の「network secret」の値を入れる。Value には推測されにくい長いランダムな文字列を入れ、同じ値を{' '}
            <code>pnpm run deploy</code> で入力する。保存した値は後から見られず、直すときは削除して追加し直す。
          </li>
          <li>
            <a href="https://claude.ai/code/routines" target="_blank" rel="noopener noreferrer">
              claude.ai/code/routines
            </a>
            でルーチンを開き（または作り）、リポジトリ <code>maronnjapan/maronn-openid-connect</code>、モデル Opus、上の環境を選び、下の「ルーチンに保存するプロンプト」を貼り付ける。コネクタはすべて外す（ルーチンを作ると、接続済みのコネクタが自動で付く）。
          </li>
          <li>
            トリガーに <strong>API</strong> を追加し、表示された URL とトークンを控える（トークンは一度しか表示されない）。
          </li>
          <li>
            リポジトリのルートで <code>pnpm run deploy</code> を実行し、API トリガーの URL とトークン、network secret の Value
            を入力する。値はこのアプリの Secret（ROUTINE_FIRE_URL、ROUTINE_TOKEN、ROUTINE_BEARER_TOKEN_HASH。Bearer
            トークンはハッシュだけ）として登録され、そのままデプロイされる。2 回目以降も同じ入力を求め、空のまま Enter を押すと登録済みの値をそのまま使う。
          </li>
          <li>
            ルーチンの詳細ページで <strong>Run now</strong> をテキストなしで実行する。ルーチンは{' '}
            <code>{`${status.appOrigin}/api/routine/ping`}</code> を呼んで結果を報告するので、セッションに <code>HTTP 200</code>{' '}
            が出れば設定は完了。<code>HTTP 401</code> なら network secret、接続できなければ許可するドメインを見直す。
          </li>
        </ol>
        <h3>許可するドメイン</h3>
        <pre>
          <code>{status.allowedDomains.join('\n')}</code>
        </pre>
        <h3>network secret</h3>
        <dl class="kv">
          <dt>Secret type</dt>
          <dd>{status.networkSecret.secretType}</dd>
          <dt>Name</dt>
          <dd>{status.networkSecret.name}</dd>
          <dt>Allowed websites</dt>
          <dd>
            <code>{status.networkSecret.allowedWebsite}</code>（このアプリのホスト）
          </dd>
          <dt>Custom headers</dt>
          <dd>
            Name <code>{status.networkSecret.header.name}</code>、Prefix <code>{status.networkSecret.header.prefix}</code>、Value
            はこのアプリに登録したトークン（<code>pnpm run deploy</code> で入力した値）
          </dd>
        </dl>
        <p>
          エージェントのプロキシが、ルーチンからこのアプリへのリクエストに <code>Authorization: Bearer</code>{' '}
          としてトークンを付けます。トークンは Claude からは見えず、このアプリはハッシュだけを持ちます。結果の受け口{' '}
          <code>{`${status.appOrigin}/api/routine/runs/<run_id>/messages`}</code> はインターネットから届く必要があるため、ローカルの{' '}
          <code>localhost</code> では本物のルーチンを試せません（ローカルでは <code>scripts/mock-routine.mjs</code> を使う）。
        </p>
      </section>

      <section class="card">
        <div class="card__head">
          <h2>ルーチンに保存するプロンプト</h2>
          <button type="button" class="button button--small" data-copy-text-from="routine-prompt">
            コピー
          </button>
        </div>
        <textarea id="routine-prompt" class="code-area" rows={14} readonly>
          {props.prompt}
        </textarea>
        <details>
          <summary>表示を確認する</summary>
          <div class="markdown-body">{raw(props.promptHtml)}</div>
        </details>
      </section>
    </Layout>
  );
}

function maskFireUrl(url: string): string {
  return url.replace(/(trig_[A-Za-z0-9]{4})[A-Za-z0-9]+/, '$1…');
}

// ---------------------------------------------------------------------------
// Sign-in related

export function SignedOutPage() {
  return (
    <Layout title="ログアウトしました">
      <div class="center-card">
        <h1>ログアウトしました</h1>
        <p class="muted">IdP からもログアウトしています。</p>
        <a class="button" href="/auth/login">
          もう一度ログインする
        </a>
      </div>
    </Layout>
  );
}

export function ErrorPage(props: { title: string; message: string; user?: CurrentUser | null; action?: { href: string; label: string } }) {
  return (
    <Layout title={props.title} user={props.user ?? null}>
      <div class="center-card">
        <h1>{props.title}</h1>
        <p>{props.message}</p>
        <a class="button" href={props.action?.href ?? '/'}>
          {props.action?.label ?? 'トップへ戻る'}
        </a>
      </div>
    </Layout>
  );
}
