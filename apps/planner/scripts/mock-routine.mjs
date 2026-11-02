#!/usr/bin/env node
/**
 * A stand-in for the routine's API trigger, for local development.
 *
 * It answers POST /v1/claude_code/routines/{id}/fire like the real endpoint
 * (bearer token, anthropic-version header, { text } body, the routine_fire
 * response), then does what the routine's saved prompt
 * (src/routine/prompt.ts) tells the Claude Code session to do:
 *
 *   1. check the JSON request (type, version 3 or 2, task, run_id,
 *      run_token); a fire without text is the check of the settings, which
 *      only pings
 *   2. ping the planner, to check that the bearer token arrives
 *   3. post a progress note, then, with the run token:
 *      - task "plan": questions (for a first request) or a plan. A plan
 *        builds on current_plan (the latest version, people's edits
 *        included), says what changed (changes) and answers every open
 *        comment (comment_replies)
 *      - task "implementation_prompt": the plan turned into a prompt
 *
 * The session adds no Authorization header, as in the real routine. The
 * bearer token comes from agentProxy() below, which plays the agent proxy of
 * the routine's environment: like its network secret (secret type Bearer),
 * it adds the token of .dev.vars.mock-routine to the requests for the
 * planner's host.
 *
 *   node scripts/mock-routine.mjs            # http://localhost:8790
 *
 * MOCK_ROUTINE_MODE: questions-then-plan (default) | plan | error | silent
 * MOCK_ROUTINE_TOKEN: the bearer token to accept (default "mock-routine-token")
 * MOCK_ROUTINE_DELAY_MS: how long the "session" takes (default 1500)
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.MOCK_ROUTINE_PORT ?? 8790);
const TOKEN = process.env.MOCK_ROUTINE_TOKEN ?? 'mock-routine-token';
const MODE = process.env.MOCK_ROUTINE_MODE ?? 'questions-then-plan';
const DELAY = Number(process.env.MOCK_ROUTINE_DELAY_MS ?? 1500);

const sessions = new Map();

/** The routine's bearer token (the network secret of a real routine's environment). */
function readCredentials() {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', '.dev.vars.mock-routine');
  if (!existsSync(file)) throw new Error(`${file} がありません。pnpm setup:local を実行してください。`);
  const vars = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^([A-Z_]+)='(.*)'$/.exec(line.trim());
    if (match) vars[match[1]] = match[2];
  }
  return vars;
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function error(res, status, type, message) {
  json(res, status, { type: 'error', error: { type, message } });
}

/** The checks of the saved prompt: anything else is not a request to answer. */
function readRequest(text) {
  let request;
  try {
    request = JSON.parse(text);
  } catch {
    return null;
  }
  const task = request?.version === 2 ? 'plan' : request?.task;
  const valid =
    request?.type === 'maronn-planner.plan-request' &&
    (request.version === 3 || request.version === 2) &&
    (task === 'plan' || task === 'implementation_prompt') &&
    /^run_[0-9a-f]{24}$/.test(request.run_id ?? '') &&
    /^[A-Za-z0-9_-]{43}$/.test(request.run_token ?? '') &&
    Array.isArray(request.conversation);
  return valid ? { ...request, task } : null;
}

function questionsResult(title) {
  return {
    kind: 'questions',
    title: `${title}について確認したいこと`,
    markdown: [
      `「${title}」の計画を立てる前に、方針が分かれる点を確認させてください。`,
      '',
      '- `packages/core` に検証関数を足すか、`packages/experimental` に置くかで、変更範囲とリリースの流れ（changeset）が変わります。',
      '- 生成コードの対象フレームワークによって、`apps/hono` と `apps/nextjs` のどちらのテンプレートを直すかが決まります。',
    ].join('\n'),
    questions: [
      { id: 'q1', question: '実装を置くパッケージはどちらにしますか？', choices: ['packages/core', 'packages/experimental'] },
      { id: 'q2', question: 'CLI の生成コードで対象にするフレームワークは？', choices: ['Hono のみ', 'Hono と Next.js', 'すべて'] },
      { id: 'q3', question: 'ほかに守るべき制約があれば教えてください（任意）。' },
    ],
  };
}

function planResult(title) {
  const markdown = `# ${title}の実装計画

## 概要

${title}を、既存のステップ関数の構成に沿って追加する。検証は部品関数に分け、生成コードのパイプラインに 1 ステップとして差し込む。

## ユースケース

| ID | 利用者 | 場面 | 操作 | 結果 |
| --- | --- | --- | --- | --- |
| UC-1 | RP の開発者 | トークンを要求する | DPoP proof を付けて \`/token\` を呼ぶ | \`cnf.jkt\` 付きのアクセストークンを受け取る |
| UC-2 | RP の開発者 | proof の \`htm\` が違う | 誤った proof で \`/token\` を呼ぶ | \`invalid_dpop_proof\` で拒否される |

### UC-1 DPoP proof 付きでトークンを受け取る

\`\`\`mermaid
sequenceDiagram
  participant RP
  participant OP as OP (/token)
  RP->>OP: POST /token + DPoP header
  OP->>OP: verifyDpopProof()
  OP-->>RP: 200 access_token (cnf.jkt)
\`\`\`

### UC-2 htm が違う proof を拒否する

\`\`\`mermaid
sequenceDiagram
  participant RP
  participant OP as OP (/token)
  RP->>OP: POST /token + DPoP header (htm: GET)
  OP->>OP: verifyDpopProof() が htm の不一致を検出
  OP-->>RP: 400 error=invalid_dpop_proof
\`\`\`

## 関連する仕様

| 仕様 | 節 | 要件 |
| --- | --- | --- |
| RFC 9449 | §4.3 | DPoP proof の \`htm\` / \`htu\` / \`iat\` を検証する（MUST） |
| RFC 9449 | §5 | アクセストークンに \`cnf.jkt\` を入れる（MUST） |

## 現状の実装

- \`packages/core/src/token-request.ts\` の \`validateTokenRequest()\` はクライアント認証の後に grant を検証している。
- 生成コードの \`endpoints/token/pipeline.ts\` はステップを順に並べており、ここに 1 ステップ足せる。

## 実装方針

### トークンエンドポイントのパイプラインに DPoP の検証を足す

今のコード（\`endpoints/token/pipeline.ts\` の \`tokenPipeline\`）：

\`\`\`ts
export const tokenPipeline = [parseRequest, authenticateClient, validateGrantType, issueAccessToken];
\`\`\`

変更後のコード：

\`\`\`ts
export const tokenPipeline = [parseRequest, authenticateClient, verifyDpop, validateGrantType, issueAccessToken];
\`\`\`

何が変わるか：クライアント認証の後で proof を検証し、不正なら grant の検証より前に \`invalid_dpop_proof\` を返す。

## 仕様から外れる独自実装

| 項目 | 仕様の扱い | 根拠の節 | この実装の振る舞い | 理由 | 相互運用への影響 |
| --- | --- | --- | --- | --- | --- |
| proof の \`iat\` の許容幅 | 定めなし | RFC 9449 §11.1 | 前後 60 秒 | 時計のずれを吸収するため | なし |

## 変更するファイル

| パス | 種類 | 内容 |
| --- | --- | --- |
| \`packages/core/src/dpop.ts\` | 追加 | proof の検証関数 |
| \`apps/hono/src/endpoints/token/steps/verify-dpop.ts\` | 追加 | 生成コードのステップ |

## 実装ステップ

- [ ] \`verifyDpopProof()\` の失敗ケースのテストを書く
- [ ] \`verifyDpopProof()\` を実装する
- [ ] トークンエンドポイントのステップに組み込む

## テスト計画

### ユースケースの整理

| ID | 成功・失敗 | 確かめる結果 |
| --- | --- | --- |
| UC-1 | 成功 | 200 と \`cnf.jkt\` 付きのアクセストークン |
| UC-2 | 失敗 | 400 と \`error=invalid_dpop_proof\` |

### ユースケースを満たす機能

| ID | 機能 | 満たすユースケース | 実装する場所 |
| --- | --- | --- | --- |
| F-1 | DPoP proof の \`htm\` / \`htu\` / \`iat\` を検証する | UC-1、UC-2 | \`packages/core/src/dpop.ts\` の \`verifyDpopProof()\` |
| F-2 | アクセストークンに \`cnf.jkt\` を入れる | UC-1 | \`apps/hono/src/endpoints/token/steps/verify-dpop.ts\` |

### 機能ごとのテストケース

| 機能 | テストの種類 | テストファイル | テストケース名 | 入力と期待する結果 | 確かめるユースケースと独自実装 |
| --- | --- | --- | --- | --- | --- |
| F-1 | 単体テスト | \`packages/core/src/dpop.test.ts\` | should accept a proof whose htm and htu match the request | 正しい proof → 検証に通る | UC-1 |
| F-1 | 単体テスト | \`packages/core/src/dpop.test.ts\` | should reject a proof whose htm does not match the request method | htm が GET の proof → \`invalid_dpop_proof\` | UC-2 |
| F-1 | 単体テスト | \`packages/core/src/dpop.test.ts\` | should accept an iat within 60 seconds | 59 秒前の iat → 通る、61 秒前 → 拒否 | UC-1、独自実装（iat の許容幅） |
| F-2 | E2E | \`tests/e2e/dpop.spec.ts\` | should issue an access token bound to the proof key | proof 付きで \`/token\` → \`cnf.jkt\` が鍵の thumbprint | UC-1 |

## CLI・samples・ドキュメントへの影響

\`--enable dpop\` を追加し、samples の \`conformance.test.ts\` を更新する。

## リスクと対策

~~nonce を必須にする~~ → まずは任意にし、設定で必須にできるようにする。

## 未決事項

なし`;
  return { kind: 'plan', title: `${title}の実装計画`, markdown, changes: '初版' };
}

/**
 * The next version of current_plan: its text as it is (people's edits
 * included), with what this round adds. Like the routine when the text was
 * left out of the fire, it reads the version from the planner too, and says
 * in changes whether that text matched current_plan.
 */
async function revisedPlanResult(request, fetchPlan) {
  const current = request.current_plan;
  const fetched = await fetchPlan(current.version);
  current.markdown ??= fetched ?? '';
  const latest = [...request.conversation].reverse().find((message) => message.role === 'user' && message.kind !== 'plan');
  const asked = (latest?.body ?? '').split('\n').find((line) => line.trim() !== '' && !line.startsWith('#'))?.trim() ?? '追加の指示';
  const comments = request.comments ?? [];
  const note = `- v${current.version + 1}：「${asked.slice(0, 60)}」${comments.length > 0 ? `とコメント ${comments.length} 件` : ''}を反映した。`;
  const markdown = /^## 未決事項$/m.test(current.markdown)
    ? current.markdown.replace(/^## 未決事項$/m, `${note}\n\n## 未決事項`)
    : `${current.markdown}\n\n${note}`;
  return {
    kind: 'plan',
    title: current.title ?? request.thread?.title ?? '計画',
    markdown,
    changes: `v${current.version}${current.edited_by_user ? '（人が編集した版）' : ''}を元に、${comments.length > 0 ? `コメント ${comments.length} 件と` : ''}最後の発言を反映した。plans の受け口で取得した v${current.version} の本文は current_plan と${fetched === current.markdown ? '一致した' : '一致しなかった'}。`,
    comment_replies: comments.map((comment) => ({
      id: comment.id,
      resolved: true,
      reply: `v${current.version + 1} に反映しました（${comment.section ?? '計画書全体'}${comment.line ? `、${comment.line} 行目` : ''}）。`,
    })),
  };
}

function implementationPromptResult(request) {
  const plan = request.current_plan;
  const title = (plan?.title ?? request.thread?.title ?? '機能').replace(/の実装計画$/, '');
  const comments = request.comments ?? [];
  const markdown = `# ${title}を実装する

## 目的

計画書 v${plan?.version ?? '?'} のとおりに ${title} を実装する。

## 前提

- リポジトリは maronnjapan/maronn-openid-connect。最初に README.md の「実装におけるルール」と「テストコードの書き方」を読む。

## 仕様の要件

- RFC 9449 §4.3：proof の htm / htu / iat を検証する（MUST）

## 変更の内容

\`\`\`ts
export const tokenPipeline = [parseRequest, authenticateClient, verifyDpop, validateGrantType, issueAccessToken];
\`\`\`

## 作業手順

- [ ] 失敗するテストを先に書く
- [ ] 実装してテストを通す

## 完了の条件

- \`pnpm test\` と型チェックが通る

## やらないこと

- 計画書の範囲外のファイルを変更しない

## 判断に迷ったとき

${comments.length > 0 ? comments.map((comment) => `- 未解決の指摘：${comment.body}`).join('\n') : '- 計画書の未決事項は無い'}`;
  return { kind: 'implementation_prompt', title: `${title}を実装する`, markdown, notes: '計画書と現在のコードの食い違いは見つからなかった。' };
}

/**
 * The agent proxy with the routine's network secret (secret type Bearer): a
 * fetch that adds Authorization: Bearer <token> to the requests for the
 * planner's host, and to no other.
 */
function agentProxy(credentials) {
  const plannerHost = new URL(credentials.PLANNER_ORIGIN).host;
  return async (url, init = {}) => {
    const headers = new Headers(init.headers ?? {});
    if (new URL(url).host === plannerHost) headers.set('Authorization', `Bearer ${credentials.ROUTINE_BEARER_TOKEN}`);
    return fetch(url, { ...init, headers });
  };
}

/** The check of the settings, as the saved prompt has the session run it before work and alone. */
async function ping(credentials, proxiedFetch) {
  const response = await proxiedFetch(`${credentials.PLANNER_ORIGIN}/api/routine/ping`);
  console.log(`[mock-routine] GET /api/routine/ping -> ${response.status} ${(await response.text()).slice(0, 200)}`);
  return response.ok;
}

/** GET /api/routine/runs/{runId}/plans/{version}: one version of the plan, as the saved prompt lets the routine read it. */
async function fetchPlanVersion(credentials, proxiedFetch, request, version) {
  const url = `${credentials.PLANNER_ORIGIN}/api/routine/runs/${request.run_id}/plans/${version}`;
  const response = await proxiedFetch(url, { headers: { 'X-Planner-Run-Token': request.run_token } });
  console.log(`[mock-routine] GET ${url} -> ${response.status}`);
  return response.ok ? (await response.text()).replace(/\n$/, '') : null;
}

async function post(credentials, proxiedFetch, request, body) {
  const url = `${credentials.PLANNER_ORIGIN}/api/routine/runs/${request.run_id}/messages`;
  const response = await proxiedFetch(url, {
    method: 'POST',
    headers: { 'X-Planner-Run-Token': request.run_token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  console.log(`[mock-routine] POST ${url} (${body.kind}) -> ${response.status} ${text.slice(0, 200)}`);
  return response;
}

async function runSession(id, text) {
  const credentials = readCredentials();
  const proxiedFetch = agentProxy(credentials);
  if (text === '') {
    await ping(credentials, proxiedFetch);
    sessions.get(id).done = true;
    return;
  }
  const request = readRequest(text);
  if (!request) {
    console.error('[mock-routine] the fire text is not a valid plan request; nothing is sent');
    return;
  }
  if (MODE === 'silent') return;
  if (!(await ping(credentials, proxiedFetch))) {
    console.error('[mock-routine] the bearer token does not reach the planner; nothing is sent');
    return;
  }
  const title = request.thread?.title ?? '機能';
  // The fire carries one plan in full (current_plan); the plans in the conversation have no body.
  const plansWithBody = request.conversation.filter((message) => message.kind === 'plan' && typeof message.body === 'string').length;
  console.log(`[mock-routine] v${request.version} task=${request.task}, current plan v${request.current_plan?.version ?? '-'}, plans with a body in the conversation: ${plansWithBody}, open comments: ${(request.comments ?? []).length}`);
  await new Promise((resolve) => setTimeout(resolve, DELAY / 2));
  await post(credentials, proxiedFetch, request, { kind: 'progress', markdown: 'リポジトリの `packages/core` と `apps/hono` を読んでいます。' });
  await new Promise((resolve) => setTimeout(resolve, DELAY / 2));
  if (MODE === 'error') {
    await post(credentials, proxiedFetch, request, { kind: 'error', markdown: 'モックのエラーです。' });
    return;
  }
  let result;
  if (request.task === 'implementation_prompt') {
    result = implementationPromptResult(request);
  } else if (request.current_plan) {
    result = await revisedPlanResult(request, (version) => fetchPlanVersion(credentials, proxiedFetch, request, version));
  } else {
    const isFirstRequest = request.conversation.length === 1;
    result = MODE === 'questions-then-plan' && isFirstRequest ? questionsResult(title) : planResult(title);
  }
  await post(credentials, proxiedFetch, request, result);
  sessions.get(id).done = true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const fire = /^\/v1\/claude_code\/routines\/(trig_[A-Za-z0-9_]+)\/fire$/.exec(url.pathname);

  if (req.method === 'POST' && fire) {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return error(res, 401, 'authentication_error', 'Invalid bearer token');
    }
    if (!req.headers['anthropic-version']) {
      return error(res, 400, 'invalid_request_error', 'anthropic-version header is required');
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return error(res, 400, 'invalid_request_error', 'Body must be JSON');
    }
    if (typeof body.text === 'string' && body.text.length > 65_536) {
      return error(res, 400, 'invalid_request_error', 'text exceeds 65,536 characters');
    }
    const id = `session_mock_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    sessions.set(id, { text: body.text ?? '', firedAt: new Date().toISOString(), done: false });
    console.log(`[mock-routine] fire ${fire[1]} -> ${id} (${(body.text ?? '').length} chars)`);
    runSession(id, body.text ?? '').catch((e) => console.error('[mock-routine]', e));
    return json(res, 200, {
      type: 'routine_fire',
      claude_code_session_id: id,
      claude_code_session_url: `http://localhost:${PORT}/sessions/${id}`,
    });
  }

  const session = /^\/sessions\/(session_mock_\w+)$/.exec(url.pathname);
  if (req.method === 'GET' && session && sessions.has(session[1])) {
    const { text, firedAt, done } = sessions.get(session[1]);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(`mock session ${session[1]}\nfired at ${firedAt}\ndone: ${done}\n\n--- fire text ---\n${text}`);
  }

  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok', mode: MODE });
  error(res, 404, 'not_found_error', 'Not found');
});

server.listen(PORT, 'localhost', () => {
  console.log(`[mock-routine] listening on http://localhost:${PORT} (mode: ${MODE})`);
});
