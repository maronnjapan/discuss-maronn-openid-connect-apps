import { describe, expect, it } from 'vitest';
import { firstHeading, parseCallbackBody } from '../src/routine/callback.js';

const noQuery = new URLSearchParams();
const json = (body: unknown) => parseCallbackBody('application/json', JSON.stringify(body), noQuery);

describe('parseCallbackBody', () => {
  describe('JSON body', () => {
    it('should accept a plan and take its title from the first heading when none is given', () => {
      expect(json({ kind: 'plan', markdown: '# DPoP の実装計画\r\n\r\n## 概要\n' })).toEqual({
        ok: true,
        message: { kind: 'plan', title: 'DPoP の実装計画', markdown: '# DPoP の実装計画\n\n## 概要', questions: [] },
      });
    });

    it('should accept questions with ids and choices', () => {
      expect(
        json({
          kind: 'questions',
          title: '確認したいこと',
          markdown: '方針を決めるために確認させてください。',
          questions: [
            { id: 'q1', question: 'nonce は必須にしますか？', choices: ['必須', '任意'] },
            { question: '対象のフレームワークは？' },
          ],
        }),
      ).toEqual({
        ok: true,
        message: {
          kind: 'questions',
          title: '確認したいこと',
          markdown: '方針を決めるために確認させてください。',
          questions: [
            { id: 'q1', question: 'nonce は必須にしますか？', choices: ['必須', '任意'] },
            { id: 'q2', question: '対象のフレームワークは？' },
          ],
        },
      });
    });

    it('should reject an unknown kind', () => {
      expect(json({ kind: 'done', markdown: 'x' })).toEqual({
        ok: false,
        error: '"kind" must be one of plan, questions, progress, error.',
      });
    });

    it('should reject an empty markdown', () => {
      expect(json({ kind: 'plan', markdown: '   ' })).toEqual({ ok: false, error: '"markdown" must be a non-empty string.' });
    });

    it('should reject questions on a plan', () => {
      expect(json({ kind: 'plan', markdown: '# a', questions: [{ id: 'q1', question: 'x' }] })).toEqual({
        ok: false,
        error: '"questions" is only allowed with kind "questions".',
      });
    });

    it('should reject duplicated question ids', () => {
      expect(
        json({ kind: 'questions', markdown: 'x', questions: [{ id: 'q1', question: 'a' }, { id: 'q1', question: 'b' }] }),
      ).toEqual({ ok: false, error: 'questions[1].id "q1" is used twice.' });
    });

    it('should reject a long progress note', () => {
      expect(json({ kind: 'progress', markdown: 'a'.repeat(4001) })).toEqual({
        ok: false,
        error: '"markdown" must be at most 4000 characters.',
      });
    });

    it('should reject a body that is not an object', () => {
      expect(parseCallbackBody('application/json', '[1]', noQuery)).toEqual({ ok: false, error: 'The body must be a JSON object.' });
    });
  });

  describe('Markdown body', () => {
    it('should take kind and title from the query string', () => {
      expect(parseCallbackBody('text/markdown; charset=utf-8', '# 計画\n本文', new URLSearchParams('kind=plan&title=PAR'))).toEqual({
        ok: true,
        message: { kind: 'plan', title: 'PAR', markdown: '# 計画\n本文', questions: [] },
      });
    });

    it('should reject other content types', () => {
      expect(parseCallbackBody('application/x-www-form-urlencoded', 'a=b', noQuery)).toEqual({
        ok: false,
        error: 'Content-Type must be application/json or text/markdown.',
      });
    });
  });
});

describe('firstHeading', () => {
  it('should return the text of the first ATX heading', () => {
    expect(firstHeading('前置き\n\n## 概要 ##\n# 後の見出し')).toBe('概要');
  });

  it('should return undefined without a heading', () => {
    expect(firstHeading('本文だけ')).toBe(undefined);
  });
});
