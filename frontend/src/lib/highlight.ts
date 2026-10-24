/**
 * Syntax highlighting for code blocks, shared by the rich editor and the
 * rendered Markdown. The highlighter and its common language set load on
 * demand in a chunk of their own, the first time a code block is shown, so a
 * page without code never pays for them. Until it arrives a block shows as
 * plain text, and once it does every waiting block is highlighted.
 *
 * The output is a small tree of text runs and class names, never HTML, so a
 * snippet cannot inject markup.
 */

import type { createLowlight } from 'lowlight';

/** The lowlight instance the language chunk builds. */
export type Highlighter = ReturnType<typeof createLowlight>;

/** A run of highlighted text. */
export interface HighlightText {
  type: 'text';
  value: string;
}

/** A highlighted span, carrying the `hljs-` classes of its token. */
export interface HighlightElement {
  type: 'element';
  tagName: string;
  properties?: { className?: unknown };
  children: HighlightNode[];
}

/** One node of a highlighted snippet. */
export type HighlightNode = HighlightText | HighlightElement;

/** A language the picker offers, with the fence names that mean it. */
export interface CodeLanguage {
  id: string;
  label: string;
  aliases: string[];
}

/** The languages a code block can be set to, in the picker's order. */
export const CODE_LANGUAGES: CodeLanguage[] = [
  { id: 'plaintext', label: 'Plain text', aliases: ['text', 'txt', 'plain'] },
  { id: 'bash', label: 'Bash', aliases: ['sh', 'zsh'] },
  { id: 'c', label: 'C', aliases: ['h'] },
  { id: 'cpp', label: 'C++', aliases: ['c++', 'cc', 'hpp', 'cxx'] },
  { id: 'csharp', label: 'C#', aliases: ['cs', 'c#'] },
  { id: 'css', label: 'CSS', aliases: [] },
  { id: 'diff', label: 'Diff', aliases: ['patch'] },
  { id: 'go', label: 'Go', aliases: ['golang'] },
  { id: 'graphql', label: 'GraphQL', aliases: ['gql'] },
  { id: 'xml', label: 'HTML and XML', aliases: ['html', 'svg', 'xhtml'] },
  { id: 'ini', label: 'INI and TOML', aliases: ['toml'] },
  { id: 'java', label: 'Java', aliases: ['jsp'] },
  {
    id: 'javascript',
    label: 'JavaScript',
    aliases: ['js', 'jsx', 'mjs', 'cjs'],
  },
  { id: 'json', label: 'JSON', aliases: ['jsonc', 'json5'] },
  { id: 'kotlin', label: 'Kotlin', aliases: ['kt', 'kts'] },
  { id: 'less', label: 'Less', aliases: [] },
  { id: 'lua', label: 'Lua', aliases: [] },
  { id: 'makefile', label: 'Makefile', aliases: ['make', 'mk'] },
  { id: 'markdown', label: 'Markdown', aliases: ['md', 'mkdown'] },
  { id: 'objectivec', label: 'Objective-C', aliases: ['objc', 'mm'] },
  { id: 'perl', label: 'Perl', aliases: ['pl', 'pm'] },
  { id: 'php', label: 'PHP', aliases: [] },
  { id: 'python', label: 'Python', aliases: ['py', 'gyp'] },
  { id: 'r', label: 'R', aliases: [] },
  { id: 'ruby', label: 'Ruby', aliases: ['rb', 'gemspec'] },
  { id: 'rust', label: 'Rust', aliases: ['rs'] },
  { id: 'scss', label: 'SCSS', aliases: [] },
  { id: 'shell', label: 'Shell session', aliases: ['console', 'shellsession'] },
  { id: 'sql', label: 'SQL', aliases: [] },
  { id: 'swift', label: 'Swift', aliases: [] },
  {
    id: 'typescript',
    label: 'TypeScript',
    aliases: ['ts', 'tsx', 'mts', 'cts'],
  },
  { id: 'yaml', label: 'YAML', aliases: ['yml'] },
];

/** The picker entry a fence language names, by its id or an alias. */
export const codeLanguage = (
  language: string | null | undefined
): CodeLanguage | undefined => {
  if (language === null || language === undefined || language === '') {
    return undefined;
  }
  const wanted = language.toLowerCase();
  return CODE_LANGUAGES.find(
    (entry) => entry.id === wanted || entry.aliases.includes(wanted)
  );
};

let loaded: Highlighter | null = null;
let pending: Promise<Highlighter> | null = null;

/** The highlighter, when its chunk has already arrived. */
export const loadedHighlighter = (): Highlighter | null => loaded;

/** Loads the highlighter and its languages once, however often it is asked. */
export const loadHighlighter = (): Promise<Highlighter> => {
  pending ??= import('./highlightLanguages').then((module) => {
    loaded = module.lowlight;
    return loaded;
  });
  return pending;
};

/** A snippet as one plain text run, for when it cannot be highlighted. */
const plain = (code: string): HighlightNode[] => [
  { type: 'text', value: code },
];

/**
 * Highlights a snippet in its fence language when the highlighter knows it,
 * and by detection otherwise.
 */
export const highlightCode = (
  highlighter: Highlighter,
  language: string | null | undefined,
  code: string
): HighlightNode[] => {
  try {
    const known =
      language !== null &&
      language !== undefined &&
      language !== '' &&
      highlighter.registered(language);
    const root = known
      ? highlighter.highlight(language, code)
      : highlighter.highlightAuto(code);
    return root.children as unknown as HighlightNode[];
  } catch {
    return plain(code);
  }
};

/** The `hljs-` classes a highlighted span carries. */
export const highlightClasses = (node: HighlightElement): string => {
  const className = node.properties?.className;
  if (Array.isArray(className)) return className.join(' ');
  return typeof className === 'string' ? className : '';
};

/** A root holding the snippet unhighlighted, shaped as lowlight answers. */
const plainRoot = (code: string): ReturnType<Highlighter['highlight']> =>
  ({
    type: 'root',
    children: plain(code),
    data: { language: undefined, relevance: 0 },
  }) as unknown as ReturnType<Highlighter['highlight']>;

/**
 * A stand in for lowlight that the editor's code block can be configured with
 * before the real one has loaded. It answers with plain text until the chunk
 * arrives and passes every call through afterwards.
 */
export const lazyLowlight = {
  highlight: (language: string, code: string) =>
    loaded === null ? plainRoot(code) : loaded.highlight(language, code),
  highlightAuto: (code: string) =>
    loaded === null ? plainRoot(code) : loaded.highlightAuto(code),
  listLanguages: (): string[] =>
    loaded === null ? [] : loaded.listLanguages(),
  registered: (language: string): boolean =>
    loaded !== null && loaded.registered(language),
};
