import katex from 'katex';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cachedMath,
  clearMathCache,
  escapeInlineMath,
  holdsInlineMath,
  INLINE_MATH,
  renderMath,
  renderMathWith,
  writeBlockMath,
  writeInlineMath,
} from './math';

afterEach(() => {
  clearMathCache();
});

describe('the inline equation rule', () => {
  it('reads $...$ with no space inside the dollars', () => {
    expect(INLINE_MATH.exec('$x^2$ rest')?.[1]).toBe('x^2');
    expect(INLINE_MATH.exec('$a \\$ b$')?.[1]).toBe('a \\$ b');
  });

  it('leaves prices and padded dollars alone', () => {
    expect(INLINE_MATH.exec('$5 and $10')).toBeNull();
    expect(INLINE_MATH.exec('$ x $')).toBeNull();
    expect(INLINE_MATH.exec('$x$5')).toBeNull();
    expect(INLINE_MATH.exec('$$x$$')).toBeNull();
  });

  it('finds text that would read as an equation', () => {
    expect(holdsInlineMath('Swap $a$ in')).toBe(true);
    expect(holdsInlineMath('From $5 to $10')).toBe(false);
    expect(holdsInlineMath('Literal \\$a$')).toBe(false);
  });

  it('escapes only the dollars that would open an equation', () => {
    expect(escapeInlineMath('Swap $a$ for $b$')).toBe('Swap \\$a$ for \\$b$');
    expect(escapeInlineMath('From $5 to $10')).toBe('From $5 to $10');
  });
});

describe('the stored forms', () => {
  it('writes an inline equation with its bare dollars escaped', () => {
    expect(writeInlineMath(' x^2 ')).toBe('$x^2$');
    expect(writeInlineMath('a $ b')).toBe('$a \\$ b$');
  });

  it('writes a block equation between fence lines', () => {
    expect(writeBlockMath('\\frac{a}{b}\n')).toBe('$$\n\\frac{a}{b}\n$$');
    expect(writeBlockMath('')).toBe('$$\n$$');
  });
});

describe('rendering', () => {
  it('renders valid LaTeX to KaTeX markup', () => {
    const result = renderMathWith(katex, 'x^2', false);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.html).toContain('katex');
  });

  it('answers a parse failure with a short error instead of throwing', () => {
    const result = renderMathWith(katex, '\\frac{a', true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toBe('');
      expect(result.error).not.toContain('KaTeX parse error');
    }
  });

  it('refuses an empty equation', () => {
    expect(renderMathWith(katex, '  ', false).ok).toBe(false);
  });

  it('keeps links and HTML out of the markup with trust off', () => {
    const result = renderMathWith(
      katex,
      '\\href{javascript:alert(1)}{x} \\htmlClass{evil}{y}',
      false
    );
    const html = result.ok ? result.html : '';
    expect(html).not.toMatch(/<a\s/);
    expect(html).not.toMatch(/class="[^"]*evil/);
  });

  it('loads KaTeX on demand and keeps the result', async () => {
    expect(cachedMath('y', true)).toBeUndefined();
    const result = await renderMath('y', true);
    expect(result.ok).toBe(true);
    expect(cachedMath('y', true)).toEqual(result);
  });
});
