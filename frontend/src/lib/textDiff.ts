/**
 * A line diff between two texts, for showing what an earlier version of a
 * description changed. A longest common subsequence over lines keeps the
 * unchanged lines aligned; texts too long for that are shown as a whole
 * replacement rather than costing the browser a large table.
 */

/** One line of a diff: kept, only in the earlier text, or only in the later. */
export interface DiffLine {
  kind: 'same' | 'removed' | 'added';
  text: string;
}

/** How many line pairs the table may hold before the diff falls back. */
const MAX_CELLS = 4_000_000;

/** The lines of `before` and `after` in order, each marked kept, removed or added. */
export const diffLines = (before: string, after: string): DiffLine[] => {
  const left = before === '' ? [] : before.split('\n');
  const right = after === '' ? [] : after.split('\n');
  if (left.length * right.length > MAX_CELLS) {
    return [
      ...left.map((text): DiffLine => ({ kind: 'removed', text })),
      ...right.map((text): DiffLine => ({ kind: 'added', text })),
    ];
  }
  const width = right.length + 1;
  const table = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        left[i] === right[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(
              table[(i + 1) * width + j] ?? 0,
              table[i * width + j + 1] ?? 0
            );
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const l = left[i] ?? '';
    const r = right[j] ?? '';
    if (l === r) {
      lines.push({ kind: 'same', text: l });
      i += 1;
      j += 1;
    } else if (
      (table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)
    ) {
      lines.push({ kind: 'removed', text: l });
      i += 1;
    } else {
      lines.push({ kind: 'added', text: r });
      j += 1;
    }
  }
  for (; i < left.length; i += 1) {
    lines.push({ kind: 'removed', text: left[i] ?? '' });
  }
  for (; j < right.length; j += 1) {
    lines.push({ kind: 'added', text: right[j] ?? '' });
  }
  return lines;
};

/** Whether a diff changes anything. */
export const hasChanges = (lines: DiffLine[]): boolean =>
  lines.some((line) => line.kind !== 'same');
