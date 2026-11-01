#!/usr/bin/env node
/**
 * A stand-in for the routine's API trigger, for local development.
 *
 * It answers POST /v1/claude_code/routines/{id}/fire like the real endpoint
 * (bearer token, anthropic-version header, { text } body, the routine_fire
 * response), then does what the routine's saved prompt
 * (src/routine/prompt.ts) tells the Claude Code session to do:
 *
 *   1. check the JSON request (type, version, run_id, run_token); a fire
 *      without text is the check of the settings, which only pings
 *   2. ping the planner, to check that the bearer token arrives
 *   3. post a progress note, then questions (for a first request) or a plan,
 *      to the planner with the run token
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
  const valid =
    request?.type === 'maronn-planner.plan-request' &&
    request.version === 2 &&
    /^run_[0-9a-f]{24}$/.test(request.run_id ?? '') &&
    /^[A-Za-z0-9_-]{43}$/.test(request.run_token ?? '') &&
    Array.isArray(request.conversation);
  return valid ? request : null;
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

## 関連する仕様

| 仕様 | 節 | 要件 |
| --- | --- | --- |
| RFC 9449 | §4.3 | DPoP proof の \`htm\` / \`htu\` / \`iat\` を検証する（MUST） |
| RFC 9449 | §5 | アクセストークンに \`cnf.jkt\` を入れる（MUST） |

## 現状の実装

- \`packages/core/src/token-request.ts\` の \`validateTokenRequest()\` はクライアント認証の後に grant を検証している。
- 生成コードの \`endpoints/token/pipeline.ts\` はステップを順に並べており、ここに 1 ステップ足せる。

## 実装方針

\`\`\`mermaid
sequenceDiagram
  participant RP
  participant OP as OP (/token)
  RP->>OP: POST /token + DPoP header
  OP->>OP: verifyDpopProof()
  OP-->>RP: access_token (cnf.jkt)
\`\`\`

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

\`\`\`ts
describe('verifyDpopProof', () => {
  it('should reject a proof whose htm does not match the request method', () => {});
});
\`\`\`

## CLI・samples・ドキュメントへの影響

\`--enable dpop\` を追加し、samples の \`conformance.test.ts\` を更新する。

## リスクと対策

~~nonce を必須にする~~ → まずは任意にし、設定で必須にできるようにする。

## 未決事項

なし`;
  return { kind: 'plan', title: `${title}の実装計画`, markdown };
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
  await new Promise((resolve) => setTimeout(resolve, DELAY / 2));
  await post(credentials, proxiedFetch, request, { kind: 'progress', markdown: 'リポジトリの `packages/core` と `apps/hono` を読んでいます。' });
  await new Promise((resolve) => setTimeout(resolve, DELAY / 2));
  if (MODE === 'error') {
    await post(credentials, proxiedFetch, request, { kind: 'error', markdown: 'モックのエラーです。' });
    return;
  }
  const isFirstRequest = request.conversation.length === 1;
  const result = MODE === 'questions-then-plan' && isFirstRequest ? questionsResult(title) : planResult(title);
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
