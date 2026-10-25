/**
 * Mermaid diagrams for fenced code blocks tagged `mermaid`, shared by the rich
 * editor and the rendered Markdown. The renderer is a pinned dependency that
 * loads on demand in chunks of its own the first time a diagram is shown, so a
 * page without one never pays for it.
 *
 * Rendering runs at Mermaid's strict security level, so diagram text cannot
 * carry script or click handlers, and the SVG it answers with has been through
 * Mermaid's own sanitiser. Diagrams are drawn in the palette of the theme the
 * page is painted in, and a diagram that does not parse answers with a short
 * error rather than throwing.
 */

import type mermaid from 'mermaid';
import type { MermaidConfig } from 'mermaid';
import { isDarkNow, parseTheme } from './theme';

/** The Mermaid module's API. */
export type MermaidApi = typeof mermaid;

/** What rendering a diagram answers with: its SVG, or why it failed. */
export type MermaidResult =
  { ok: true; svg: string } | { ok: false; error: string };

/** The fence language that marks a code block as a diagram. */
export const MERMAID_LANGUAGE = 'mermaid';

/** The small graph a new diagram starts from. */
export const MERMAID_STARTER = [
  'flowchart LR',
  '  A[Idea] --> B{Ready?}',
  '  B -->|Yes| C[Build]',
  '  B -->|No| D[Refine]',
  '  D --> B',
].join('\n');

/** The longest error a block shows inline. */
const MAX_ERROR = 160;

/** How many rendered diagrams are kept for reuse. */
const CACHE_SIZE = 64;

/** Whether a fence language names a Mermaid diagram. */
export const isMermaidLanguage = (
  language: string | null | undefined
): boolean => language?.trim().toLowerCase() === MERMAID_LANGUAGE;

/** The colours a diagram is drawn in, matching the app's own tokens. */
const PALETTES = {
  dark: {
    darkMode: true,
    background: '#1b1c20',
    primaryColor: '#232429',
    primaryTextColor: '#e7e7eb',
    primaryBorderColor: '#3a3c44',
    secondaryColor: '#2a2b31',
    secondaryTextColor: '#e7e7eb',
    secondaryBorderColor: '#3a3c44',
    tertiaryColor: '#1b1c20',
    tertiaryTextColor: '#e7e7eb',
    tertiaryBorderColor: '#2a2b31',
    mainBkg: '#232429',
    nodeBorder: '#3a3c44',
    clusterBkg: '#1b1c20',
    clusterBorder: '#2a2b31',
    lineColor: '#9b9da7',
    textColor: '#e7e7eb',
    titleColor: '#e7e7eb',
    edgeLabelBackground: '#1b1c20',
    noteBkgColor: '#2a2b31',
    noteTextColor: '#e7e7eb',
    noteBorderColor: '#3a3c44',
    actorBkg: '#232429',
    actorBorder: '#3a3c44',
    actorTextColor: '#e7e7eb',
    signalColor: '#9b9da7',
    signalTextColor: '#e7e7eb',
  },
  light: {
    darkMode: false,
    background: '#f7f7f8',
    primaryColor: '#ffffff',
    primaryTextColor: '#1b1c20',
    primaryBorderColor: '#cfd0d7',
    secondaryColor: '#efeff2',
    secondaryTextColor: '#1b1c20',
    secondaryBorderColor: '#cfd0d7',
    tertiaryColor: '#f7f7f8',
    tertiaryTextColor: '#1b1c20',
    tertiaryBorderColor: '#e5e5ea',
    mainBkg: '#ffffff',
    nodeBorder: '#cfd0d7',
    clusterBkg: '#f7f7f8',
    clusterBorder: '#e5e5ea',
    lineColor: '#62646f',
    textColor: '#1b1c20',
    titleColor: '#1b1c20',
    edgeLabelBackground: '#f7f7f8',
    noteBkgColor: '#efeff2',
    noteTextColor: '#1b1c20',
    noteBorderColor: '#cfd0d7',
    actorBkg: '#ffffff',
    actorBorder: '#cfd0d7',
    actorTextColor: '#1b1c20',
    signalColor: '#62646f',
    signalTextColor: '#1b1c20',
  },
} as const;

/** The font diagrams fall back to when the page's cannot be read. */
const FALLBACK_FONT = 'Inter, ui-sans-serif, system-ui, sans-serif';

/** The configuration a diagram renders under, for one painted theme. */
export const mermaidConfig = (
  dark: boolean,
  fontFamily: string = FALLBACK_FONT
): MermaidConfig => ({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'base',
  fontFamily,
  themeVariables: {
    ...PALETTES[dark ? 'dark' : 'light'],
    fontFamily,
    fontSize: '13px',
  },
});

/** Whether the page is painted dark, from the attribute the theme sets. */
export const isPaintedDark = (): boolean => {
  const attribute =
    globalThis.document.documentElement.getAttribute('data-theme');
  return isDarkNow(attribute === null ? 'system' : parseTheme(attribute));
};

/**
 * Calls a listener whenever the painted theme may have changed: the theme
 * attribute moving, or the system preference flipping while it is followed.
 * Returns the unsubscribe function.
 */
export const subscribePaintedTheme = (listener: () => void): (() => void) => {
  const observer = new MutationObserver(listener);
  observer.observe(globalThis.document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  let media: MediaQueryList | null = null;
  try {
    media = globalThis.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', listener);
  } catch {
    media = null;
  }
  return () => {
    observer.disconnect();
    media?.removeEventListener('change', listener);
  };
};

/** A thrown parse or render failure, as one short line. */
export const shortMermaidError = (error: unknown): string => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  const lines = message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^-*\^$/.test(line));
  const first = lines[0] ?? '';
  const last = lines.at(-1) ?? '';
  const joined =
    first.endsWith(':') && lines.length > 1 ? `${first} ${last}` : first;
  const text = joined === '' ? 'The diagram could not be drawn.' : joined;
  return text.length > MAX_ERROR ? `${text.slice(0, MAX_ERROR - 1)}…` : text;
};

let pending: Promise<MermaidApi> | null = null;

/** Loads the renderer once, however often it is asked, retrying after a failure. */
export const loadMermaid = (): Promise<MermaidApi> => {
  pending ??= import('mermaid').then(
    (module) => module.default,
    (error: unknown) => {
      pending = null;
      throw error;
    }
  );
  return pending;
};

const cache = new Map<string, MermaidResult>();
let queue: Promise<unknown> = Promise.resolve();
let sequence = 0;

/** The page's body font, for diagram labels to match the text around them. */
const pageFont = (): string => {
  try {
    const font = globalThis.getComputedStyle(
      globalThis.document.body
    ).fontFamily;
    return font === '' ? FALLBACK_FONT : font;
  } catch {
    return FALLBACK_FONT;
  }
};

/** Removes whatever a failed render left behind in the document. */
const sweep = (id: string): void => {
  for (const stray of [id, `d${id}`, `i${id}`]) {
    globalThis.document.getElementById(stray)?.remove();
  }
};

/** Renders one diagram, after any render already under way has finished. */
const renderNow = async (
  api: MermaidApi,
  source: string,
  dark: boolean
): Promise<MermaidResult> => {
  sequence += 1;
  const id = `standupless-mermaid-${String(sequence)}`;
  try {
    api.initialize(mermaidConfig(dark, pageFont()));
    await api.parse(source);
    const { svg } = await api.render(id, source);
    return { ok: true, svg };
  } catch (error) {
    sweep(id);
    return { ok: false, error: shortMermaidError(error) };
  }
};

/** A rendered diagram already kept for a source and theme, if any. */
export const cachedMermaid = (
  source: string,
  dark: boolean
): MermaidResult | undefined => cache.get(`${String(dark)}:${source}`);

/**
 * Renders a diagram's source to SVG in the given theme. Renders run one at a
 * time, because Mermaid's configuration is global, and a result is kept so a
 * diagram shown again is not drawn twice.
 */
export const renderMermaid = async (
  source: string,
  dark: boolean
): Promise<MermaidResult> => {
  const key = `${String(dark)}:${source}`;
  const kept = cache.get(key);
  if (kept !== undefined) return kept;
  if (source.trim() === '') {
    return { ok: false, error: 'The diagram is empty.' };
  }
  let api: MermaidApi;
  try {
    api = await loadMermaid();
  } catch {
    return { ok: false, error: 'The diagram renderer could not load.' };
  }
  const run = queue.then(() => renderNow(api, source, dark));
  queue = run.catch(() => undefined);
  const result = await run;
  cache.set(key, result);
  if (cache.size > CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return result;
};

/** Forgets every kept render, for tests. */
export const clearMermaidCache = (): void => {
  cache.clear();
};
