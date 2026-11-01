import { describe, expect, it } from 'vitest';
import {
  describeSectionChanges,
  diffHunks,
  diffLines,
  sectionChanges,
  splitSections,
  unifiedDiff,
} from '../src/plan-diff.js';

const plan = (sections: Record<string, string>, title = 'DPoP の実装計画') =>
  [`# ${title}`, ...Object.entries(sections).map(([heading, body]) => `## ${heading}\n\n${body}`)].join('\n\n');

describe('splitSections', () => {
  it('should split a plan at its level 1 and level 2 headings', () => {
    expect(splitSections('# 計画\n\n## 概要\n\n本文\n\n### 詳細\n\n細かい話\n\n## 未決事項 ##\n\nなし')).toEqual([
      { key: '#', label: 'タイトル', body: '# 計画' },
      { key: '概要', label: '概要', body: '本文\n\n### 詳細\n\n細かい話' },
      { key: '未決事項', label: '未決事項', body: 'なし' },
    ]);
  });

  // CommonMark §4.5: a heading inside a fenced code block is code, not a heading
  it('should not take headings inside fenced code blocks', () => {
    expect(splitSections('## 実装方針\n\n````md\n## 見出しではない\n```\n````\n\n## テスト計画\n\nx').map((section) => section.key)).toEqual([
      '実装方針',
      'テスト計画',
    ]);
  });

  it('should keep text before the first heading and repeated headings apart', () => {
    expect(splitSections('前置き\n\n## 補足\n\na\n\n## 補足\n\nb').map((section) => [section.key, section.label])).toEqual([
      ['', '（冒頭）'],
      ['補足', '補足'],
      ['補足 (2)', '補足 (2)'],
    ]);
  });
});

describe('sectionChanges', () => {
  it('should name the changed, added and removed sections', () => {
    const before = plan({ 概要: 'a', 実装方針: 'b', 旧節: 'c' });
    const after = plan({ 概要: 'a', 実装方針: 'B', リスクと対策: 'd' });
    expect(sectionChanges(before, after)).toEqual({ changed: ['実装方針'], added: ['リスクと対策'], removed: ['旧節'] });
  });

  it('should count a new title as a change of the title', () => {
    expect(sectionChanges(plan({ 概要: 'a' }), plan({ 概要: 'a' }, 'PAR の実装計画')).changed).toEqual(['タイトル']);
  });

  it('should ignore blank lines around a section', () => {
    expect(sectionChanges('## 概要\n\na\n', '## 概要\na\n\n\n')).toEqual({ changed: [], added: [], removed: [] });
  });
});

describe('describeSectionChanges', () => {
  it('should list the sections by the kind of change', () => {
    expect(describeSectionChanges({ changed: ['概要', 'テスト計画'], added: ['リスクと対策'], removed: [] })).toBe(
      '概要、テスト計画を変更。リスクと対策を追加',
    );
  });
});

describe('diffLines', () => {
  it('should return the shortest edit script', () => {
    expect(diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e'])).toEqual([
      { op: ' ', line: 'a' },
      { op: '-', line: 'b' },
      { op: '+', line: 'x' },
      { op: ' ', line: 'c' },
      { op: ' ', line: 'd' },
      { op: '+', line: 'e' },
    ]);
  });

  it('should handle an empty side', () => {
    expect(diffLines([], ['a'])).toEqual([{ op: '+', line: 'a' }]);
    expect(diffLines(['a'], [])).toEqual([{ op: '-', line: 'a' }]);
  });

  it('should give up when the edits exceed the limit', () => {
    expect(diffLines(['a', 'b', 'c'], ['x', 'y', 'z'], 4)).toBe(null);
  });

  // Applying the script to the old lines gives the new lines, whatever the input.
  it('should produce a script that turns the old lines into the new ones', () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let round = 0; round < 50; round++) {
      const a = Array.from({ length: Math.floor(random() * 30) }, () => 'abcde'[Math.floor(random() * 5)]!);
      const b = Array.from({ length: Math.floor(random() * 30) }, () => 'abcde'[Math.floor(random() * 5)]!);
      const script = diffLines(a, b)!;
      expect(script.filter((line) => line.op !== '+').map((line) => line.line)).toEqual(a);
      expect(script.filter((line) => line.op !== '-').map((line) => line.line)).toEqual(b);
    }
  });
});

describe('diffHunks', () => {
  it('should merge nearby changes and keep context lines around them', () => {
    const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'].join('\n');
    const after = ['1', '2', 'three', '4', '5', '6', '7', '8', '9', '10', '11', 'twelve'].join('\n');
    expect(diffHunks(before, after, { context: 1 })!.map((hunk) => hunk.header)).toEqual(['@@ -2,3 +2,3 @@', '@@ -11,2 +11,2 @@']);
    expect(diffHunks(before, after, { context: 4 })!.map((hunk) => hunk.header)).toEqual(['@@ -1,12 +1,12 @@']);
  });

  it('should return no hunks for the same text', () => {
    expect(diffHunks('a\nb', 'a\nb')).toEqual([]);
  });
});

describe('unifiedDiff', () => {
  it('should write the unified format with the version labels', () => {
    expect(unifiedDiff('# T\n\n## 概要\n\n旧\n', '# T\n\n## 概要\n\n新\n', { fromLabel: 'v1', toLabel: 'v2', context: 1 })).toBe(
      ['--- v1', '+++ v2', '@@ -4,3 +4,3 @@', ' ', '-旧', '+新', ' '].join('\n'),
    );
  });

  it('should name the line before an insertion at the top of a range of no old lines', () => {
    expect(unifiedDiff('', 'a', { fromLabel: 'v1', toLabel: 'v2', context: 0 })).toBe(['--- v1', '+++ v2', '@@ -1,1 +1,1 @@', '-', '+a'].join('\n'));
    expect(unifiedDiff('a', 'a\nb', { fromLabel: 'v1', toLabel: 'v2', context: 0 })).toBe(['--- v1', '+++ v2', '@@ -1,0 +2,1 @@', '+b'].join('\n'));
  });
});
