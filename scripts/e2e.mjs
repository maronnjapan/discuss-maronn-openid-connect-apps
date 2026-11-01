#!/usr/bin/env node
/**
 * End-to-end check of the two apps and the mock routine, as a browser would
 * use them: sign in at the IdP, ask for a plan, answer the questions, read
 * the plan, and sign out. Run it against `pnpm dev`.
 *
 *   pnpm e2e
 *
 * The callback API is also probed with wrong tokens and a second result, and
 * the IdP with the client credentials grant it no longer has.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { LOCAL, PLANNER_DIR, readDevVars } from './lib.mjs';

const PLANNER = process.env.E2E_PLANNER_ORIGIN ?? LOCAL.plannerOrigin;
const IDP = process.env.E2E_IDP_ORIGIN ?? LOCAL.idpOrigin;
const USERNAME = process.env.E2E_USERNAME ?? 'testuser';
const PASSWORD = process.env.E2E_PASSWORD ?? 'password';

/** Cookies by origin (enough for these two apps, which use different cookie names). */
const jar = new Map();

function storeCookies(url, response) {
  const origin = new URL(url).origin;
  const cookies = jar.get(origin) ?? new Map();
  for (const header of response.headers.getSetCookie()) {
    const [pair, ...attributes] = header.split(';');
    const [name, ...rest] = pair.split('=');
    const value = rest.join('=');
    const expired = attributes.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === '';
    if (expired) cookies.delete(name.trim());
    else cookies.set(name.trim(), value);
  }
  jar.set(origin, cookies);
}

function cookieHeader(url) {
  const cookies = jar.get(new URL(url).origin);
  return cookies ? [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') : '';
}

async function request(url, init = {}) {
  const headers = new Headers(init.headers ?? {});
  const cookie = cookieHeader(url);
  if (cookie) headers.set('Cookie', cookie);
  const response = await fetch(url, { ...init, headers, redirect: 'manual' });
  storeCookies(url, response);
  return response;
}

/** Follows redirects across the two apps like a browser, returning the last response. */
async function navigate(url, init = {}) {
  let response = await request(url, init);
  let current = url;
  for (let hops = 0; hops < 10 && response.status >= 300 && response.status < 400; hops++) {
    current = new URL(response.headers.get('Location'), current).href;
    response = await request(current);
  }
  return { response, url: current };
}

function form(fields) {
  return new URLSearchParams(fields);
}

function postForm(url, fields, origin) {
  return navigate(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
    body: form(fields),
  });
}

function hidden(html, name) {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  assert.ok(match, `hidden field ${name} not found`);
  return match[1];
}

async function waitForSignature(threadPath, previous, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await request(`${PLANNER}${threadPath}/status`);
    const data = await response.json();
    if (!data.running && data.signature !== previous) return data;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${threadPath} did not finish in time`);
}

const steps = [];
async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    steps.push(`✔ ${name} (${Date.now() - started}ms)`);
    console.log(`\x1b[32m✔\x1b[0m ${name}`);
  } catch (error) {
    console.log(`\x1b[31m✘\x1b[0m ${name}`);
    throw error;
  }
}

let threadPath;
let runId;
// The token the network secret of the routine's environment adds (the mock's stand-in reads the same file).
const routineBearerToken = readDevVars(join(PLANNER_DIR, '.dev.vars.mock-routine')).ROUTINE_BEARER_TOKEN;
assert.ok(routineBearerToken, 'apps/planner/.dev.vars.mock-routine has no ROUTINE_BEARER_TOKEN; run pnpm setup:local');

await step('未ログインで planner を開くと IdP のログイン画面に着く', async () => {
  const { response, url } = await navigate(`${PLANNER}/`);
  assert.equal(new URL(url).origin, IDP);
  assert.equal(new URL(url).pathname, '/login');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /ユーザー ID/);
  globalThis.loginHtml = html;
});

await step('誤ったパスワードではログインできない', async () => {
  const { response } = await postForm(
    `${IDP}/login`,
    { csrf_token: hidden(globalThis.loginHtml, 'csrf_token'), username: USERNAME, password: 'wrong-password' },
    IDP,
  );
  const html = await response.text();
  assert.match(html, /ユーザー ID またはパスワードが正しくありません。/);
  globalThis.loginHtml = html;
});

await step('ログインと同意の後、planner の計画一覧に戻る', async () => {
  const login = await postForm(
    `${IDP}/login`,
    { csrf_token: hidden(globalThis.loginHtml, 'csrf_token'), username: USERNAME, password: PASSWORD },
    IDP,
  );
  let { response, url } = login;
  if (new URL(url).pathname === '/consent') {
    const html = await response.text();
    assert.match(html, /アクセスの許可/);
    ({ response, url } = await postForm(`${IDP}/consent`, { csrf_token: hidden(html, 'csrf_token'), action: 'approve' }, IDP));
  }
  assert.equal(url, `${PLANNER}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /実装計画/);
});

await step('他のサイトからのフォーム送信は拒否される（CSRF）', async () => {
  const response = await request(`${PLANNER}/plans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' },
    body: form({ title: 'x', feature: 'y' }),
  });
  assert.equal(response.status, 403);
});

await step('依頼を送るとルーチンが起動し、質問が返ってくる', async () => {
  const response = await request(`${PLANNER}/plans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: PLANNER },
    body: form({
      title: 'DPoP 対応',
      feature: '- RFC 9449 の DPoP proof を `/token` で検証したい\n- アクセストークンに `cnf.jkt` を入れたい',
      specs: 'RFC 9449',
      notes: '',
    }),
  });
  assert.equal(response.status, 303);
  threadPath = new URL(response.headers.get('Location'), PLANNER).pathname;
  assert.match(threadPath, /^\/plans\/thr_[0-9a-f]{24}$/);

  const running = await (await request(`${PLANNER}${threadPath}`)).text();
  assert.match(running, /data-poll-url="\/plans\/thr_/);

  const status = await waitForSignature(threadPath, '');
  assert.equal(status.status, 'awaiting_answer');
  const html = await (await request(`${PLANNER}${threadPath}`)).text();
  assert.match(html, /質問に回答する/);
  assert.match(html, /name="choice\.q1" value="packages\/experimental"/);
  assert.match(html, /<code>packages\/core<\/code>/);
  assert.match(html, /Claude Code のセッションを開く/);
});

await step('回答を送ると計画書が返り、Markdown として表示される', async () => {
  const before = await (await request(`${PLANNER}${threadPath}/status`)).json();
  const response = await request(`${PLANNER}${threadPath}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: PLANNER },
    body: form({ 'choice.q1': 'packages/experimental', 'answer.q1': '', 'choice.q2': 'Hono のみ', 'answer.q3': '既存の API は壊さない', message: '' }),
  });
  assert.equal(response.status, 303);
  const status = await waitForSignature(threadPath, before.signature);
  assert.equal(status.status, 'plan_ready');

  const html = await (await request(`${PLANNER}${threadPath}`)).text();
  assert.match(html, /計画書 v1/);
  assert.match(html, /<h1 id="msg_[0-9a-f]+-h1">DPoP 対応の実装計画<\/h1>/);
  assert.match(html, /<div class="table-wrap"><table>/);
  assert.match(html, /<pre class="mermaid">sequenceDiagram/);
  assert.match(html, /<pre><code class="language-ts">/);
  assert.match(html, /class="task-list-item-checkbox" disabled="" type="checkbox"/);
  assert.match(html, /<s>nonce を必須にする<\/s>/);
  assert.match(html, /<summary>目次<\/summary>/);
  // The plan names the use cases and the departures from the specifications.
  assert.match(html, /<h2 id="msg_[0-9a-f]+-h\d+">ユースケース<\/h2>/);
  assert.match(html, /<h2 id="msg_[0-9a-f]+-h\d+">仕様から外れる独自実装<\/h2>/);
  // The reply was composed from the answer form.
  assert.match(html, /<strong>選択:<\/strong> packages\/experimental/);
  assert.match(html, /既存の API は壊さない/);

  const plan = await request(`${PLANNER}${threadPath}/plan.md`);
  assert.equal(plan.headers.get('Content-Type'), 'text/markdown; charset=utf-8');
  assert.match(await plan.text(), /^# DPoP 対応の実装計画\n/);
});

await step('IdP は client credentials グラントを扱わない（ルーチンは IdP を使わない）', async () => {
  const metadata = await (await fetch(`${IDP}/.well-known/openid-configuration`)).json();
  assert.ok(!metadata.grant_types_supported.includes('client_credentials'), JSON.stringify(metadata.grant_types_supported));

  const plannerSecret = readDevVars(join(PLANNER_DIR, '.dev.vars')).OIDC_CLIENT_SECRET;
  const response = await fetch(`${IDP}/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`planner:${plannerSecret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'unsupported_grant_type');
});

await step('結果の受け口は Bearer トークンと run トークンの両方を求め、二重の結果を拒否する', async () => {
  const html = await (await request(`${PLANNER}${threadPath}`)).text();
  const sessionUrl = /href="(http:\/\/localhost:8790\/sessions\/session_mock_\w+)"/.exec(html)?.[1];
  assert.ok(sessionUrl, 'session link not found');
  const text = await (await fetch(sessionUrl)).text();
  const fire = JSON.parse(text.slice(text.indexOf('{')));
  runId = fire.run_id;
  const url = `${PLANNER}/api/routine/runs/${fire.run_id}/messages`;
  const send = (headers) =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ kind: 'plan', markdown: '# 二重送信' }) });

  const noBearerToken = await send({ 'X-Planner-Run-Token': fire.run_token });
  assert.equal(noBearerToken.status, 401);
  assert.match(noBearerToken.headers.get('WWW-Authenticate'), /^Bearer error="invalid_token"/);

  const wrongBearerToken = await send({ Authorization: `Bearer ${routineBearerToken}x`, 'X-Planner-Run-Token': fire.run_token });
  assert.equal(wrongBearerToken.status, 401);
  assert.equal((await wrongBearerToken.json()).error_description, 'The Bearer token is invalid');

  const wrongRunToken = await send({ Authorization: `Bearer ${routineBearerToken}`, 'X-Planner-Run-Token': 'x'.repeat(43) });
  assert.equal(wrongRunToken.status, 401);
  assert.equal((await wrongRunToken.json()).error, 'invalid_run_token');

  const again = await send({ Authorization: `Bearer ${routineBearerToken}`, 'X-Planner-Run-Token': fire.run_token });
  assert.equal(again.status, 409);

  const context = await fetch(url.replace(/\/messages$/, '/context'), {
    headers: { Authorization: `Bearer ${routineBearerToken}`, 'X-Planner-Run-Token': fire.run_token },
  });
  assert.equal(context.status, 409);
});

await step('ping はルーチンの Bearer トークンが届いているかを答える（network secret の確認）', async () => {
  const withoutToken = await fetch(`${PLANNER}/api/routine/ping`);
  assert.equal(withoutToken.status, 401);
  assert.match(withoutToken.headers.get('WWW-Authenticate'), /^Bearer error="invalid_token"/);

  const withToken = await fetch(`${PLANNER}/api/routine/ping`, { headers: { Authorization: `Bearer ${routineBearerToken}` } });
  assert.equal(withToken.status, 200);
  assert.deepEqual(await withToken.json(), { ok: true });
});

await step('他人のスレッドとしては開けない（所有者チェック）', async () => {
  const response = await fetch(`${PLANNER}${threadPath}`, { redirect: 'manual' });
  assert.equal(response.status, 302);
});

await step('ログアウトすると IdP のセッションも終わり、planner のログアウト画面に戻る', async () => {
  const response = await request(`${PLANNER}/auth/logout`, { method: 'POST', headers: { Origin: PLANNER } });
  assert.equal(response.status, 303);
  const location = new URL(response.headers.get('Location'));
  assert.equal(location.origin + location.pathname, `${IDP}/logout`);
  assert.equal(location.searchParams.get('post_logout_redirect_uri'), `${PLANNER}/signed-out`);
  assert.ok(location.searchParams.get('id_token_hint'));

  // With an id_token_hint for the current session the IdP may log out without
  // asking (RP-Initiated Logout 1.0 §2); otherwise it shows its confirmation.
  let { response: page, url } = await navigate(location.href);
  if (url !== `${PLANNER}/signed-out`) {
    const html = await page.text();
    assert.match(html, /ログアウトしますか？/);
    ({ url } = await postForm(`${IDP}/logout/approve`, { csrf_token: hidden(html, 'csrf_token') }, IDP));
  }
  assert.equal(url, `${PLANNER}/signed-out`);

  const after = await request(`${PLANNER}/`);
  assert.equal(after.status, 302);
  // The IdP session ended too: signing in again asks for the password.
  const { url: loginUrl } = await navigate(`${PLANNER}/auth/login`);
  assert.equal(new URL(loginUrl).origin + new URL(loginUrl).pathname, `${IDP}/login`);
});

console.log(`\nE2E: ${steps.length} 件すべて成功（run: ${runId}）`);
