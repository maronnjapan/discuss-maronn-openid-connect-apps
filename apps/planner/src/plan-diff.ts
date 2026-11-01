/**
 * Comparing two versions of a plan: which sections changed, and a line diff.
 *
 * The routine gets only the latest version of a plan in full. The history of
 * the earlier versions goes with it as short records: what changed and why
 * (the summary Claude Code or the editor wrote) and which sections changed
 * (sectionChanges below). When people edited the latest version, the routine
 * also gets the line diff of their edit (unifiedDiff), so it keeps what they
 * changed. The pages use both to show what changed between two versions.
 *
 * A section is the text from a heading of level 1 or 2 (ATX, as the saved
 * prompt asks for) up to the next one; deeper headings belong to the section
 * they are in. Lines inside fenced code blocks are never headings.
 */

export interface Section {
  /** '' for the text before the first heading, '#' for the title (level 1), otherwise the level 2 heading. */
  key: string;
  label: string;
  /** The section's lines without its heading line (with it for the title, so a new title counts as a change). */
  body: string;
}

export interface SectionChanges {
  changed: string[];
  added: string[];
  removed: string[];
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HEADING = /^ {0,3}(#{1,2})(?:[ \t]+(.*?))?[ \t]*$/;

function headingText(raw: string | undefined): string {
  // An optional closing sequence of #s is not part of the heading (CommonMark §4.2).
  return (raw ?? '').replace(/(?:^|[ \t]+)#+$/, '').trim();
}

export function splitSections(markdown: string): Section[] {
  const sections: Section[] = [];
  const seen = new Map<string, number>();
  let current = { key: '', label: '（冒頭）', lines: [] as string[] };
  let fence: { char: string; length: number } | null = null;

  const close = () => {
    const body = current.lines.join('\n').trim();
    if (current.key !== '' || body !== '') sections.push({ key: current.key, label: current.label, body });
  };

  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      const match = FENCE_CLOSE.exec(line);
      if (match && match[1]![0] === fence.char && match[1]!.length >= fence.length) fence = null;
      current.lines.push(line);
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = { char: open[1]![0]!, length: open[1]!.length };
      current.lines.push(line);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      close();
      const level = heading[1]!.length;
      const name = level === 1 ? '#' : headingText(heading[2]);
      const label = level === 1 ? 'タイトル' : name;
      // The same heading twice (two "## 補足") stays two sections.
      const count = (seen.get(name) ?? 0) + 1;
      seen.set(name, count);
      current = {
        key: count > 1 ? `${name} (${count})` : name,
        label: count > 1 ? `${label} (${count})` : label,
        lines: level === 1 ? [line] : [],
      };
      continue;
    }
    current.lines.push(line);
  }
  close();
  return sections;
}

/** The sections of `after` that differ from `before`, by heading. */
export function sectionChanges(before: string, after: string): SectionChanges {
  const old = splitSections(before);
  const next = splitSections(after);
  const oldBodies = new Map(old.map((section) => [section.key, section.body]));
  const nextKeys = new Set(next.map((section) => section.key));
  return {
    changed: next.filter((section) => oldBodies.has(section.key) && oldBodies.get(section.key) !== section.body).map((section) => section.label),
    added: next.filter((section) => !oldBodies.has(section.key)).map((section) => section.label),
    removed: old.filter((section) => !nextKeys.has(section.key)).map((section) => section.label),
  };
}

/** How many section names each list keeps, and how long a name may be, when they are shown or sent. */
export const SECTION_LIST_LIMIT = 20;
const SECTION_NAME_LIMIT = 100;

/**
 * The changes with each list cut to SECTION_LIST_LIMIT names (the rest
 * counted as 「ほか N 節」) and long headings shortened, so an edit that
 * touches thousands of sections stays short in the routine's payload and on
 * the page.
 */
export function limitSectionChanges(changes: SectionChanges): SectionChanges {
  const limit = (names: string[]) => {
    const kept = names.slice(0, SECTION_LIST_LIMIT).map((name) => (name.length > SECTION_NAME_LIMIT ? `${name.slice(0, SECTION_NAME_LIMIT)}…` : name));
    return names.length > SECTION_LIST_LIMIT ? [...kept, `ほか ${names.length - SECTION_LIST_LIMIT} 節`] : kept;
  };
  return { changed: limit(changes.changed), added: limit(changes.added), removed: limit(changes.removed) };
}

export function hasSectionChanges(changes: SectionChanges): boolean {
  return changes.changed.length + changes.added.length + changes.removed.length > 0;
}

/** For the pages: 「概要、テスト計画を変更。リスクと対策を追加」. */
export function describeSectionChanges(all: SectionChanges): string {
  const changes = limitSectionChanges(all);
  const parts = [
    changes.changed.length > 0 ? `${changes.changed.join('、')}を変更` : '',
    changes.added.length > 0 ? `${changes.added.join('、')}を追加` : '',
    changes.removed.length > 0 ? `${changes.removed.join('、')}を削除` : '',
  ].filter((part) => part !== '');
  return parts.length > 0 ? parts.join('。') : '節の変更なし（空白や改行だけの違い）';
}

// ---------------------------------------------------------------------------
// Line diff (Myers, "An O(ND) Difference Algorithm and Its Variations", 1986)

export interface DiffLine {
  op: ' ' | '-' | '+';
  line: string;
}

/**
 * The shortest edit script from `a` to `b`, as equal, deleted and inserted
 * lines. Null when it needs more than maxEdits insertions and deletions: such
 * a diff is too long to be of use, and its cost grows with the square of
 * that number.
 */
export function diffLines(a: readonly string[], b: readonly string[], maxEdits = 2_000): DiffLine[] | null {
  // The versions of a plan share most of their lines; trim the common ends first.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const middle = shortestEdit(a.slice(start, endA), b.slice(start, endB), maxEdits);
  if (middle === null) return null;
  const equal = (line: string): DiffLine => ({ op: ' ', line });
  return [...a.slice(0, start).map(equal), ...middle, ...a.slice(endA).map(equal)];
}

function shortestEdit(a: readonly string[], b: readonly string[], maxEdits: number): DiffLine[] | null {
  const n = a.length;
  const m = b.length;
  if (n + m > maxEdits && (n === 0 || m === 0)) return null;
  if (n === 0) return b.map((line) => ({ op: '+', line }));
  if (m === 0) return a.map((line) => ({ op: '-', line }));
  const max = n + m;
  const offset = max + 1;
  // v[offset + k]: the furthest x reached on diagonal k.
  const v = new Int32Array(2 * max + 3);
  // trace[d]: v before round d, only for the diagonals round d reads (-d-1 … d+1).
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, maxEdits); d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], a: readonly string[], b: readonly string[]): DiffLine[] {
  const lines: DiffLine[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const before = trace[d]!;
    const at = (k: number) => before[k + d + 1]!;
    const k = x - y;
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      lines.push({ op: ' ', line: a[x - 1]! });
      x--;
      y--;
    }
    if (d > 0) lines.push(x === previousX ? { op: '+', line: b[previousY]! } : { op: '-', line: a[previousX]! });
    x = previousX;
    y = previousY;
  }
  return lines.reverse();
}

export interface DiffHunk {
  /** "@@ -12,7 +12,9 @@" */
  header: string;
  lines: DiffLine[];
}

const toLines = (text: string) => text.replace(/\r\n?/g, '\n').split('\n');

/** The changes from `before` to `after` in hunks with `context` lines around them; null when too different. */
export function diffHunks(before: string, after: string, options: { context?: number; maxEdits?: number } = {}): DiffHunk[] | null {
  const context = options.context ?? 3;
  const lines = diffLines(toLines(before), toLines(after), options.maxEdits);
  if (lines === null) return null;

  const positions: { a: number; b: number }[] = [];
  let a = 0;
  let b = 0;
  for (const line of lines) {
    positions.push({ a, b });
    if (line.op !== '+') a++;
    if (line.op !== '-') b++;
  }

  const groups: [number, number][] = [];
  lines.forEach((line, index) => {
    if (line.op === ' ') return;
    const last = groups[groups.length - 1];
    if (last && index - last[1] - 1 <= 2 * context) last[1] = index;
    else groups.push([index, index]);
  });

  return groups.map(([first, last]) => {
    const from = Math.max(0, first - context);
    const to = Math.min(lines.length - 1, last + context);
    const slice = lines.slice(from, to + 1);
    const oldCount = slice.filter((line) => line.op !== '+').length;
    const newCount = slice.filter((line) => line.op !== '-').length;
    const start = positions[from]!;
    // In the unified format a range of no lines names the line before it.
    const range = (begin: number, count: number) => `${count === 0 ? begin : begin + 1},${count}`;
    return { header: `@@ -${range(start.a, oldCount)} +${range(start.b, newCount)} @@`, lines: slice };
  });
}

/** The unified diff of two versions ("" when they are the same, null when too different). */
export function unifiedDiff(
  before: string,
  after: string,
  options: { fromLabel: string; toLabel: string; context?: number; maxEdits?: number },
): string | null {
  const hunks = diffHunks(before, after, options);
  if (hunks === null) return null;
  if (hunks.length === 0) return '';
  return [
    `--- ${options.fromLabel}`,
    `+++ ${options.toLabel}`,
    ...hunks.flatMap((hunk) => [hunk.header, ...hunk.lines.map((line) => `${line.op}${line.line}`)]),
  ].join('\n');
}
