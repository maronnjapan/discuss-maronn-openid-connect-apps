import { describe, expect, it } from 'vitest';
import { composeReply, composeRequest } from '../src/routes/plans.js';

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
