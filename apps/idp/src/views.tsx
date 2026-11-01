/** @jsxImportSource hono/jsx */
/**
 * The Japanese screens of the IdP, injected through the views option of
 * applyOidc() so the generated views.tsx stays as the CLI wrote it.
 *
 * The forms keep the field names and values the generated pages read:
 * csrf_token / username / password on /login, action=approve|deny on
 * /consent, and csrf_token on /logout/approve.
 */
import type { Child } from 'hono/jsx';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { raw } from 'hono/html';
import type {
  ConsentPageParams,
  ErrorPageParams,
  LoginPageParams,
  Views,
} from './oidc-provider/views.js';
import type {
  LogoutCompletedPageParams,
  LogoutConfirmationPageParams,
} from './oidc-provider/features/rp-initiated-logout/views.js';

export const SERVICE_NAME = 'maronn IdP';

const STYLE = `
:root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --fg:#1d2330; --muted:#5d6675; --line:#d9dde3; --accent:#2457d6; --accent-fg:#fff; --danger:#b42318; }
@media (prefers-color-scheme: dark) { :root { --bg:#14171c; --card:#1d2128; --fg:#e7eaf0; --muted:#a2abb8; --line:#333a45; --accent:#7aa2ff; --accent-fg:#0d1117; --danger:#ff8a80; } }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px 16px; background:var(--bg); color:var(--fg); font-family: system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif; line-height:1.7; }
main { width:100%; max-width:420px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:32px 28px; }
.brand { font-size:13px; color:var(--muted); letter-spacing:.04em; margin:0 0 4px; }
h1 { font-size:22px; margin:0 0 20px; }
label { display:block; font-size:14px; font-weight:600; margin:16px 0 6px; }
input[type=text], input[type=password] { width:100%; padding:10px 12px; font-size:16px; border:1px solid var(--line); border-radius:8px; background:transparent; color:inherit; }
input:focus-visible, button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.actions { display:flex; gap:12px; margin-top:24px; }
button { flex:1; padding:11px 16px; font-size:15px; font-weight:600; border-radius:8px; border:1px solid var(--accent); background:var(--accent); color:var(--accent-fg); cursor:pointer; }
button.secondary { background:transparent; color:var(--fg); border-color:var(--line); }
.error { color:var(--danger); border:1px solid currentColor; border-radius:8px; padding:10px 12px; font-size:14px; margin:0 0 8px; }
.muted { color:var(--muted); font-size:14px; }
ul.scopes { padding-left:20px; margin:8px 0 0; }
ul.scopes li { margin:4px 0; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
`;

export function Page(props: { title: string; children?: Child }): JSX.Element {
  return (
    <>
      {raw('<!DOCTYPE html>')}
      <html lang="ja">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="robots" content="noindex" />
          <title>{`${props.title} | ${SERVICE_NAME}`}</title>
          <style>{raw(STYLE)}</style>
        </head>
        <body>
          <main>
            <p class="brand">{SERVICE_NAME}</p>
            {props.children}
          </main>
        </body>
      </html>
    </>
  );
}

const MESSAGES: Record<string, string> = {
  'Invalid credentials': 'ユーザー ID またはパスワードが正しくありません。',
  'Too many login attempts': 'ログインの試行回数が上限に達しました。しばらく待ってから、アプリからやり直してください。',
  'No authorization request is in progress in this browser. Start again from the application.':
    'このブラウザで進行中のログインがありません。アプリからやり直してください。',
};

function translate(message: string): string {
  return MESSAGES[message] ?? message;
}

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  openid: 'あなたを識別する ID（sub）',
  profile: '名前などのプロフィール',
  email: 'メールアドレス',
  address: '住所',
  phone: '電話番号',
  offline_access: 'ログアウトした後もアクセスを続けること',
};

function loginPage(params: LoginPageParams): JSX.Element {
  return (
    <Page title="ログイン">
      <h1>ログイン</h1>
      {params.error ? (
        <p class="error" role="alert">
          {translate(params.error)}
          {params.remainingAttempts !== undefined ? `（残り ${params.remainingAttempts} 回）` : null}
        </p>
      ) : null}
      <form method="post" action="/login">
        <input type="hidden" name="csrf_token" value={params.csrfToken} />
        <label for="username">ユーザー ID</label>
        <input
          type="text"
          id="username"
          name="username"
          value={params.loginHint ?? ''}
          autocomplete="username"
          autocapitalize="off"
          spellcheck={false}
          required
          autofocus
        />
        <label for="password">パスワード</label>
        <input type="password" id="password" name="password" autocomplete="current-password" required />
        <div class="actions">
          <button type="submit">ログイン</button>
        </div>
      </form>
      {(params.loginMethods ?? []).map((method) => (
        <>
          <hr />
          {method}
        </>
      ))}
      <p class="muted" style="margin-top:20px">アカウントは管理者が発行します。</p>
    </Page>
  );
}

// The two button values carry the decision (OIDC Core 1.0 §3.1.2.4); the
// consent endpoint accepts exactly "approve" and "deny".
function consentPage(params: ConsentPageParams): JSX.Element {
  return (
    <Page title="アクセスの許可">
      <h1>アクセスの許可</h1>
      <p>
        アプリ <code>{params.clientId}</code> が、次の情報へのアクセスを求めています。
      </p>
      <ul class="scopes">
        {params.scopes.map((scope) => (
          <li>
            {SCOPE_DESCRIPTIONS[scope] ?? scope} <span class="muted">（<code>{scope}</code>）</span>
          </li>
        ))}
      </ul>
      <form method="post" action="/consent">
        <input type="hidden" name="csrf_token" value={params.csrfToken} />
        <div class="actions">
          <button type="submit" name="action" value="deny" class="secondary">
            拒否する
          </button>
          <button type="submit" name="action" value="approve">
            許可する
          </button>
        </div>
      </form>
    </Page>
  );
}

function errorPage(params: ErrorPageParams): JSX.Element {
  return (
    <Page title="エラー">
      <h1>エラーが発生しました</h1>
      <p class="error" role="alert">
        {translate(params.error)}
      </p>
      {params.errorDescription ? <p class="muted">{translate(params.errorDescription)}</p> : null}
      <p class="muted">HTTP {params.statusCode}</p>
    </Page>
  );
}

// RP-Initiated Logout 1.0 §2: the wording is the same on every path into the
// confirmation, so the page tells nothing about the session or the hint.
function logoutConfirmationPage(params: LogoutConfirmationPageParams): JSX.Element {
  return (
    <Page title="ログアウト">
      <h1>ログアウトしますか？</h1>
      <p>{SERVICE_NAME} からログアウトします。心当たりがない場合は、このページを閉じてください。</p>
      <form method="post" action="/logout/approve">
        <input type="hidden" name="csrf_token" value={params.csrfToken} />
        <div class="actions">
          <button type="submit">ログアウトする</button>
        </div>
      </form>
    </Page>
  );
}

function logoutCompletedPage(_params: LogoutCompletedPageParams): JSX.Element {
  return (
    <Page title="ログアウトしました">
      <h1>ログアウトしました</h1>
      <p>このページは閉じてかまいません。</p>
    </Page>
  );
}

export const japaneseViews: Partial<Views> = {
  loginPage,
  consentPage,
  errorPage,
  logoutConfirmationPage,
  logoutCompletedPage,
};
