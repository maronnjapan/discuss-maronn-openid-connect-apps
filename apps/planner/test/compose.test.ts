import { describe, expect, it } from 'vitest';
import { composePromptRequest, composeReply, composeRequest, guestName, REPLY_FOR_COMMENTS } from '../src/compose.js';

describe('composeRequest', () => {
  it('should put the feature, the specs and the notes under their own headings', () => {
    expect(composeRequest({ title: 'PAR', feature: 'PAR を使いたい', specs: 'RFC 9126', notes: 'Hono だけ' })).toBe(
      '## 作りたい機能\n\nPAR を使いたい\n\n## 関連する仕様\n\nRFC 9126\n\n## 前提・制約・補足\n\nHono だけ',
    );
  });

  it('should leave out empty optional sections', () => {
    expect(composeRequest({ title: 'PAR', feature: 'PAR を使いたい', specs: '', notes: '' })).toBe('## 作りたい機能\n\nPAR を使いたい');
  });
});

describe('composeReply', () => {
  const questions = [
    { id: 'q1', question: '置き場所は？', choices: ['core', 'experimental'] },
    { id: 'q2', question: '対象は？' },
  ];

  it('should list each question with its choice and answer', () => {
    expect(composeReply(questions, { 'choice.q1': 'experimental', 'answer.q1': '既存 API は壊さない', 'answer.q2': 'Hono' })).toBe(
      '## 質問への回答\n\n### q1. 置き場所は？\n\n**選択:** experimental\n\n既存 API は壊さない\n\n### q2. 対象は？\n\nHono',
    );
  });

  it('should mark unanswered questions and add the extra message', () => {
    expect(composeReply(questions, { 'choice.q1': 'core', message: 'テストも厚めに' })).toBe(
      '## 質問への回答\n\n### q1. 置き場所は？\n\n**選択:** core\n\n### q2. 対象は？\n\n（回答なし。判断は任せる）\n\n## ほかに伝えること\n\nテストも厚めに',
    );
  });

  it('should return null when nothing was answered', () => {
    expect(composeReply(questions, { 'answer.q1': '  ', message: '' })).toBe(null);
  });

  it('should use the message alone for a follow-up without questions', () => {
    expect(composeReply([], { message: 'E2E を足して\r\nほしい' })).toBe('E2E を足して\nほしい');
  });
});

describe('composeReply with open comments', () => {
  it('should ask to address the open comments when the follow-up is left empty', () => {
    expect(composeReply([], { message: '' }, { openComments: 2 })).toBe(REPLY_FOR_COMMENTS);
  });

  it('should still ask for answers when questions are pending', () => {
    expect(composeReply([{ id: 'q1', question: '置き場所は？' }], {}, { openComments: 2 })).toBe(null);
  });
});

describe('composePromptRequest', () => {
  it('should name the plan version and add the formatting instructions under a heading', () => {
    expect(composePromptRequest(3, 'Codex 向けに英語で')).toBe(
      '計画書 v3 から、生成 AI に実装させるためのプロンプトを作ってください。\n\n## 整形の指示\n\nCodex 向けに英語で',
    );
    expect(composePromptRequest(1, '')).toBe('計画書 v1 から、生成 AI に実装させるためのプロンプトを作ってください。');
  });
});

describe('guestName', () => {
  it('should keep one line without control and bidirectional characters', () => {
    expect(guestName('  Bob\n  Smith‮\u0007 ')).toBe('Bob Smith');
  });

  it('should be null when nothing is left, and cut long names', () => {
    expect(guestName(' ​ ')).toBe(null);
    expect(guestName('あ'.repeat(60))).toBe('あ'.repeat(40));
  });
});
