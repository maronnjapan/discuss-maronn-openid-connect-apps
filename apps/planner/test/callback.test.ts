import { describe, expect, it } from 'vitest';
import { firstHeading, parseCallbackBody } from '../src/routine/callback.js';

const noQuery = new URLSearchParams();
const json = (body: unknown) => parseCallbackBody('application/json', JSON.stringify(body), noQuery);

describe('parseCallbackBody', () => {
  describe('JSON body', () => {
    it('should accept a plan and take its title from the first heading when none is given', () => {
      expect(json({ kind: 'plan', markdown: '# DPoP の実装計画\r\n\r\n## 概要\n' })).toEqual({
        ok: true,
        message: { kind: 'plan', title: 'DPoP の実装計画', markdown: '# DPoP の実装計画\n\n## 概要', questions: [], commentReplies: [] },
      });
    });

    it('should accept the changes of a plan and the replies to comments', () => {
      expect(
        json({
          kind: 'plan',
          markdown: '# 計画 v2',
          changes: '  E2E を追加した\r\n',
          comment_replies: [
            { id: 'cmt_0123456789abcdef01234567', resolved: true, reply: 'テスト計画に追加した' },
            { id: 'cmt_89abcdef0123456789abcdef', resolved: false, reply: '仕様の範囲外なので見送る' },
          ],
        }),
      ).toEqual({
        ok: true,
        message: {
          kind: 'plan',
          title: '計画 v2',
          markdown: '# 計画 v2',
          questions: [],
          changes: 'E2E を追加した',
          commentReplies: [
            { id: 'cmt_0123456789abcdef01234567', resolved: true, reply: 'テスト計画に追加した' },
            { id: 'cmt_89abcdef0123456789abcdef', resolved: false, reply: '仕様の範囲外なので見送る' },
          ],
        },
      });
    });

    it('should accept an implementation prompt with notes and take its title from the first heading', () => {
      expect(json({ kind: 'implementation_prompt', markdown: '# DPoP を実装する\n\n## 目的', notes: '計画と現状のずれは無い' })).toEqual({
        ok: true,
        message: {
          kind: 'implementation_prompt',
          title: 'DPoP を実装する',
          markdown: '# DPoP を実装する\n\n## 目的',
          questions: [],
          notes: '計画と現状のずれは無い',
          commentReplies: [],
        },
      });
    });

    it('should reject fields of another kind', () => {
      expect(json({ kind: 'questions', markdown: 'x', changes: 'y' })).toEqual({ ok: false, error: '"changes" is only allowed with kind "plan".' });
      expect(json({ kind: 'plan', markdown: 'x', notes: 'y' })).toEqual({ ok: false, error: '"notes" is only allowed with kind "implementation_prompt".' });
      expect(json({ kind: 'implementation_prompt', markdown: 'x', comment_replies: [] })).toEqual({
        ok: false,
        error: '"comment_replies" is only allowed with kind "plan" or "questions".',
      });
    });

    it('should reject a comment reply without a valid id, a resolved flag or a reply', () => {
      expect(json({ kind: 'plan', markdown: 'x', comment_replies: [{ id: 'cmt_1', resolved: true, reply: 'a' }] })).toEqual({
        ok: false,
        error: 'comment_replies[0].id must be a comment id (cmt_ and 24 hex digits).',
      });
      expect(json({ kind: 'plan', markdown: 'x', comment_replies: [{ id: 'cmt_0123456789abcdef01234567', reply: 'a' }] })).toEqual({
        ok: false,
        error: 'comment_replies[0].resolved must be true or false.',
      });
      expect(json({ kind: 'plan', markdown: 'x', comment_replies: [{ id: 'cmt_0123456789abcdef01234567', resolved: false, reply: ' ' }] })).toEqual({
        ok: false,
        error: 'comment_replies[0].reply must be a non-empty string.',
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
          commentReplies: [],
        },
      });
    });

    it('should reject an unknown kind', () => {
      expect(json({ kind: 'done', markdown: 'x' })).toEqual({
        ok: false,
        error: '"kind" must be one of plan, questions, progress, error, implementation_prompt.',
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
        message: { kind: 'plan', title: 'PAR', markdown: '# 計画\n本文', questions: [], commentReplies: [] },
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
