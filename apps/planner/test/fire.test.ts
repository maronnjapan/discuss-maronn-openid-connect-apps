import { describe, expect, it } from 'vitest';
import { fireRoutine, ROUTINE_TEXT_LIMIT } from '../src/routine/fire.js';

const config = {
  fireUrl: 'https://api.anthropic.com/v1/claude_code/routines/trig_01TEST/fire',
  token: 'sk-ant-oat01-test',
};

function recordingFetch(response: Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('fireRoutine', () => {
  describe('Request', () => {
    it('should POST the text to the fire URL with the bearer token and API version headers', async () => {
      const { calls, fetchImpl } = recordingFetch(
        Response.json({ type: 'routine_fire', claude_code_session_id: 'session_1', claude_code_session_url: 'https://claude.ai/code/session_1' }),
      );
      await fireRoutine(config, '依頼本文', fetchImpl);
      expect(calls.length).toBe(1);
      expect(calls[0]!.url).toBe(config.fireUrl);
      expect(calls[0]!.init.method).toBe('POST');
      expect(calls[0]!.init.headers).toEqual({
        Authorization: 'Bearer sk-ant-oat01-test',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: '依頼本文' });
    });

    it('should not call the endpoint when the text exceeds 65,536 characters', async () => {
      const { calls, fetchImpl } = recordingFetch(Response.json({}));
      const result = await fireRoutine(config, 'a'.repeat(ROUTINE_TEXT_LIMIT + 1), fetchImpl);
      expect(calls.length).toBe(0);
      expect(result).toEqual({
        ok: false,
        status: 0,
        errorType: 'text_too_long',
        message: 'ルーチンに渡すテキストが 65,536 文字を超えています。',
      });
    });
  });

  describe('Response', () => {
    it('should return the session id and URL of a successful fire', async () => {
      const { fetchImpl } = recordingFetch(
        Response.json({ type: 'routine_fire', claude_code_session_id: 'session_01H', claude_code_session_url: 'https://claude.ai/code/session_01H' }),
      );
      expect(await fireRoutine(config, 'x', fetchImpl)).toEqual({
        ok: true,
        sessionId: 'session_01H',
        sessionUrl: 'https://claude.ai/code/session_01H',
      });
    });

    it('should report the Retry-After of a rate-limited fire', async () => {
      const { fetchImpl } = recordingFetch(
        Response.json(
          { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } },
          { status: 429, headers: { 'Retry-After': '600' } },
        ),
      );
      expect(await fireRoutine(config, 'x', fetchImpl)).toEqual({
        ok: false,
        status: 429,
        errorType: 'rate_limit_error',
        message: 'ルーチンの起動回数の上限（1 時間あたり）に達しました。約 10 分後に再実行できます。（Rate limited）',
        retryAfterSeconds: 600,
      });
    });

    it('should explain an authentication error', async () => {
      const { fetchImpl } = recordingFetch(
        Response.json({ type: 'error', error: { type: 'authentication_error', message: 'bad token' } }, { status: 401 }),
      );
      expect(await fireRoutine(config, 'x', fetchImpl)).toEqual({
        ok: false,
        status: 401,
        errorType: 'authentication_error',
        message: 'ルーチンのトークン（ROUTINE_TOKEN）が正しくありません。（bad token）',
      });
    });

    it('should treat a 2xx response without session fields as unexpected', async () => {
      const { fetchImpl } = recordingFetch(Response.json({ type: 'routine_fire' }));
      expect(await fireRoutine(config, 'x', fetchImpl)).toEqual({
        ok: false,
        status: 200,
        errorType: 'unexpected_response',
        message: 'Routines の API から想定外の応答が返りました。',
      });
    });

    it('should report a network failure', async () => {
      const fetchImpl = (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch;
      expect(await fireRoutine(config, 'x', fetchImpl)).toEqual({
        ok: false,
        status: 0,
        errorType: 'network_error',
        message: 'Routines の API に接続できませんでした。（fetch failed）',
      });
    });
  });
});
