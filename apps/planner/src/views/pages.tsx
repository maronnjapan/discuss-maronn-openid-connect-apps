/** @jsxImportSource hono/jsx */
import { raw } from 'hono/html';
import type { CurrentUser } from '../auth/session.js';
import type { NewPlanValues } from '../compose.js';
import type { ThreadSummaryRow } from '../db.js';
import { Flash, formatDate, Layout, MarkdownField, StatusBadge } from './layout.js';

export type { NewPlanValues } from '../compose.js';

// ---------------------------------------------------------------------------
// Dashboard

export function DashboardPage(props: { user: CurrentUser; threads: ThreadSummaryRow[]; routineConfigured: boolean }) {
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
                  {thread.has_prompt ? <span class="badge badge--prompt">実装用プロンプトあり</span> : null}
                  {thread.open_comments > 0 ? <span class="badge badge--open">未解決のコメント {thread.open_comments}</span> : null}
                  {thread.share_token ? <span class="badge badge--shared">共有中</span> : null}
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
        <p>
          計画書づくりと、計画書を実装用プロンプトに整形する作業は、同じルーチンが依頼の task で切り替えて行います。ルーチンは 1 つで足ります。planner
          の更新で下のプロンプトが変わったときは、ルーチンの Edit からプロンプトを差し替えてから <code>pnpm run deploy</code>{' '}
          を実行します（プロンプトは新旧どちらの形の依頼も受け付けるので、先に差し替えても止まりません）。
        </p>
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
