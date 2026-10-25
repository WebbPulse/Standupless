/**
 * LaTeX math for the editor and the rendered Markdown, stored in the dialect
 * GitHub and most Markdown readers share: `$...$` for an equation inside a
 * line and a `$$` fence for one on lines of its own.
 *
 * An inline equation follows Pandoc's rule so prices are left alone: the
 * opening `$` is followed by a character that is not a space, the closing one
 * is preceded by one and is not followed by a digit, and `$` inside the
 * equation is written `\$`. A block opens with `$$` on a line of its own and
 * closes at the next such line, or sits on one line as `$$ x^2 $$`.
 *
 * Rendering uses KaTeX, a pinned dependency that loads on demand with its
 * stylesheet and bundled fonts the first time an equation is shown, so a page
 * without math never pays for it. KaTeX runs with `trust` off, so `\href`,
 * `\includegraphics` and the `\html*` commands cannot reach the page, and an
 * equation that does not parse answers with a short error instead of
 * throwing. Plain text surfaces such as email keep the LaTeX source as typed.
 */

import type katex from 'katex';

/** The KaTeX module's API. */
export type KatexApi = typeof katex;

/** What rendering an equation answers with: its markup, or why it failed. */
export type MathResult =
  { ok: true; html: string } | { ok: false; error: string };

/** The longest error an equation shows inline. */
const MAX_ERROR = 160;

/** How many rendered equations are kept for reuse. */
const CACHE_SIZE = 256;

/** The largest equation source KaTeX is asked to render. */
const MAX_SOURCE = 4000;

/** The inline equation at the start of a string, by Pandoc's rule. */
export const INLINE_MATH =
  /^\$(?![\s$])((?:\\[\s\S]|[^\\$\n])*?[^\\\s$])\$(?![\d$])/;

/**
 * The inline equation source of a pattern the static parser composes into
 * its inline grammar, with one capture group for the LaTeX.
 */
export const INLINE_MATH_SOURCE = INLINE_MATH.source.slice(1);

/** A line that opens or closes a block equation. */
export const MATH_FENCE = /^\s{0,3}\$\$\s*$/;

/** A block equation written on one line. */
export const MATH_ONE_LINE = /^\s{0,3}\$\$(?!\$)(.*?[^\s$].*?)\$\$\s*$/;

/** Whether the character at an index follows an odd run of backslashes. */
const isEscaped = (text: string, index: number): boolean => {
  let count = 0;
  for (let at = index - 1; at >= 0 && text[at] === '\\'; at -= 1) count += 1;
  return count % 2 === 1;
};

/** The indexes of each `$` in some text that would open an inline equation. */
const mathOpenings = (text: string): number[] => {
  const found: number[] = [];
  for (
    let index = text.indexOf('$');
    index !== -1;
    index = text.indexOf('$', index + 1)
  ) {
    if (!isEscaped(text, index) && INLINE_MATH.test(text.slice(index))) {
      found.push(index);
    }
  }
  return found;
};

/** Whether text holds a `$` that would read as an inline equation. */
export const holdsInlineMath = (text: string): boolean =>
  mathOpenings(text).length > 0;

/**
 * Text written so it reads back as itself rather than as an equation: each
 * `$` that would open one is escaped, and nothing else changes, so prices and
 * a lone dollar sign stay as typed.
 */
export const escapeInlineMath = (text: string): string => {
  let out = '';
  let from = 0;
  for (const index of mathOpenings(text)) {
    out += `${text.slice(from, index)}\\`;
    from = index;
  }
  return `${out}${text.slice(from)}`;
};

/** An inline equation's LaTeX as it is stored, with any bare `$` escaped. */
export const writeInlineMath = (latex: string): string =>
  `$${latex.trim().replace(/(?<!\\)\$/g, '\\$')}$`;

/** A block equation's LaTeX as it is stored, fenced by `$$` lines. */
export const writeBlockMath = (latex: string): string => {
  const body = latex.replace(/^\n+|\s+$/g, '');
  return body === '' ? '$$\n$$' : `$$\n${body}\n$$`;
};

/** A thrown parse failure, as one short line. */
export const shortMathError = (error: unknown): string => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  const line = message
    .split('\n')[0]
    ?.replace(/^KaTeX parse error:\s*/, '')
    .trim();
  const text =
    line === undefined || line === ''
      ? 'The equation could not be drawn.'
      : line;
  return text.length > MAX_ERROR ? `${text.slice(0, MAX_ERROR - 1)}…` : text;
};

let pending: Promise<KatexApi> | null = null;

/**
 * Loads KaTeX and its stylesheet once, however often it is asked, retrying
 * after a failure.
 */
export const loadKatex = (): Promise<KatexApi> => {
  pending ??= Promise.all([
    import('katex'),
    import('katex/dist/katex.min.css'),
  ]).then(
    ([module]) => module.default,
    (error: unknown) => {
      pending = null;
      throw error;
    }
  );
  return pending;
};

const cache = new Map<string, MathResult>();

/** The cache key of an equation in one display mode. */
const keyOf = (latex: string, display: boolean): string =>
  `${display ? 'block' : 'inline'}:${latex}`;

/** Renders an equation with a loaded KaTeX, never throwing. */
export const renderMathWith = (
  api: KatexApi,
  latex: string,
  display: boolean
): MathResult => {
  if (latex.trim() === '') {
    return { ok: false, error: 'The equation is empty.' };
  }
  if (latex.length > MAX_SOURCE) {
    return { ok: false, error: 'The equation is too long to draw.' };
  }
  try {
    const html = api.renderToString(latex, {
      displayMode: display,
      throwOnError: true,
      trust: false,
      strict: 'ignore',
      output: 'htmlAndMathml',
      maxSize: 20,
      maxExpand: 1000,
    });
    return { ok: true, html };
  } catch (error) {
    return { ok: false, error: shortMathError(error) };
  }
};

/** A rendered equation already kept for a source and mode, if any. */
export const cachedMath = (
  latex: string,
  display: boolean
): MathResult | undefined => cache.get(keyOf(latex, display));

/**
 * Renders an equation's LaTeX to KaTeX markup, inline or as a display block.
 * A result is kept so an equation shown again is not typeset twice.
 */
export const renderMath = async (
  latex: string,
  display: boolean
): Promise<MathResult> => {
  const key = keyOf(latex, display);
  const kept = cache.get(key);
  if (kept !== undefined) return kept;
  let api: KatexApi;
  try {
    api = await loadKatex();
  } catch {
    return { ok: false, error: 'The equation renderer could not load.' };
  }
  const result = renderMathWith(api, latex, display);
  cache.set(key, result);
  if (cache.size > CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return result;
};

/** Forgets every kept render, for tests. */
export const clearMathCache = (): void => {
  cache.clear();
};
