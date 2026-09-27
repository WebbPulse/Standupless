/**
 * The app accent is the brand accent.
 *
 * This reads the stylesheet as text rather than rendering a component, because
 * the bug it defends against is invisible to a rendered test: a component whose
 * variant sets one colour and a class that tries to override it both appear in
 * the class list, and which one wins is decided by the order Tailwind emits
 * them. Pinning the token definitions catches the accent drifting back apart
 * from the brand, which is the way that failure starts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');

/** Every `--name: value;` declaration in the stylesheet, in source order. */
const declarations = (name: string): string[] =>
  [...css.matchAll(new RegExp(`--${name}:\\s*([^;]+);`, 'g'))].map((match) =>
    (match[1] ?? '').trim()
  );

describe('the accent tokens', () => {
  it('takes the accent from the brand in every theme', () => {
    const values = declarations('accent');
    expect(values).toHaveLength(3);
    for (const value of values) {
      expect(value).toBe('var(--brand-accent)');
    }
  });

  it('takes the accent foreground and the soft fill from the brand', () => {
    for (const value of declarations('on-accent')) {
      expect(value).toBe('var(--brand-accent-foreground)');
    }
    for (const value of declarations('accent-soft')) {
      expect(value).toBe('var(--brand-accent-muted)');
    }
  });

  it('keeps no teal from the accent the brand replaced', () => {
    for (const stale of ['#17776f', '#125f59', '#4fbfb5', '#6fd0c7']) {
      expect(css).not.toContain(stale);
    }
  });

  it('imports the brand tokens before it reads them', () => {
    expect(css.indexOf("@import './brand/tokens.css';")).toBeLessThan(
      css.indexOf('--accent:')
    );
  });
});
