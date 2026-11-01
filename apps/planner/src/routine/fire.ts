/**
 * Starts a run of the Claude Code routine through its API trigger.
 *
 *   POST https://api.anthropic.com/v1/claude_code/routines/{trig_id}/fire
 *   Authorization: Bearer sk-ant-oat01-...
 *   anthropic-version: 2023-06-01
 *   { "text": "..." }   (at most 65,536 characters)
 *
 * The response carries the new session's id and URL. The endpoint does not
 * wait for the session or return its output, which is why the routine sends
 * its result back to the app (src/routine/callback.ts).
 * https://platform.claude.com/docs/en/api/claude-code/routines-fire
 */

/** The longest `text` the fire endpoint accepts. */
export const ROUTINE_TEXT_LIMIT = 65_536;

export interface RoutineConfig {
  /** The full URL the API trigger dialog shows, ending in /fire. */
  fireUrl: string;
  /** The routine's bearer token (sk-ant-oat01-...). */
  token: string;
}

export type FireResult =
  | { ok: true; sessionId: string; sessionUrl: string }
  | { ok: false; status: number; errorType: string; message: string; retryAfterSeconds?: number };

const ANTHROPIC_VERSION = '2023-06-01';
// Older integrations send this beta header; the endpoint accepts requests
// with and without it, and sending it keeps working on accounts where the
// endpoint is still behind the beta.
const ROUTINE_BETA = 'experimental-cc-routine-2026-04-01';

export async function fireRoutine(
  config: RoutineConfig,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FireResult> {
  if (text.length > ROUTINE_TEXT_LIMIT) {
    return { ok: false, status: 0, errorType: 'text_too_long', message: describeError(400, 'text_too_long') };
  }
  let response: Response;
  try {
    response = await fetchImpl(config.fireUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': ROUTINE_BETA,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      errorType: 'network_error',
      message: `${describeError(0, 'network_error')}（${error instanceof Error ? error.message : String(error)}）`,
    };
  }

  const body = (await response.json().catch(() => undefined)) as
    | { type?: string; claude_code_session_id?: string; claude_code_session_url?: string; error?: { type?: string; message?: string } }
    | undefined;

  if (response.ok && body?.claude_code_session_id && body.claude_code_session_url) {
    return { ok: true, sessionId: body.claude_code_session_id, sessionUrl: body.claude_code_session_url };
  }
  if (response.ok) {
    return { ok: false, status: response.status, errorType: 'unexpected_response', message: describeError(response.status, 'unexpected_response') };
  }

  const errorType = body?.error?.type ?? 'unknown_error';
  const retryAfter = Number(response.headers.get('retry-after'));
  const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined;
  const detail = body?.error?.message ? `（${body.error.message}）` : '';
  return {
    ok: false,
    status: response.status,
    errorType,
    message: describeError(response.status, errorType, retryAfterSeconds) + detail,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}

/** A message for the person using the app, by the error table of the fire endpoint. */
export function describeError(status: number, errorType: string, retryAfterSeconds?: number): string {
  if (errorType === 'text_too_long') return 'ルーチンに渡すテキストが 65,536 文字を超えています。';
  if (errorType === 'network_error') return 'Routines の API に接続できませんでした。';
  if (errorType === 'unexpected_response') return 'Routines の API から想定外の応答が返りました。';
  switch (status) {
    case 400:
      return 'ルーチンがリクエストを受け付けませんでした。ルーチンが一時停止されていないか確認してください。';
    case 401:
      return 'ルーチンのトークン（ROUTINE_TOKEN）が正しくありません。';
    case 403:
      return 'このアカウントでは Routines の API を使えません。';
    case 404:
      return 'ルーチンが見つかりません。ROUTINE_FIRE_URL を確認してください。';
    case 429:
      return retryAfterSeconds !== undefined
        ? `ルーチンの起動回数の上限（1 時間あたり）に達しました。約 ${Math.ceil(retryAfterSeconds / 60)} 分後に再実行できます。`
        : 'ルーチンの起動回数の上限（1 時間あたり）に達しました。';
    default:
      return status >= 500
        ? 'Routines の API で一時的なエラーが起きました。少し待ってから再実行してください。'
        : `Routines の API がエラーを返しました（HTTP ${status}）。`;
  }
}
