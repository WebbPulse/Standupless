/** The line diff the description history shows against the current text. */

import { describe, expect, it } from 'vitest';
import { diffLines, hasChanges } from './textDiff';

describe('diffLines', () => {
  it('keeps unchanged lines and marks the ones that moved', () => {
    expect(diffLines('a\nb\nc', 'a\nx\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'x' },
      { kind: 'same', text: 'c' },
    ]);
  });

  it('reads an empty text as no lines', () => {
    expect(diffLines('', 'one')).toEqual([{ kind: 'added', text: 'one' }]);
    expect(diffLines('one', '')).toEqual([{ kind: 'removed', text: 'one' }]);
  });

  it('reports no change for identical texts', () => {
    expect(hasChanges(diffLines('same\ntext', 'same\ntext'))).toBe(false);
    expect(hasChanges(diffLines('a', 'b'))).toBe(true);
  });
});
