/**
 * Reading and writing Markdown through the editor schema, shared by the live
 * editor and by the tests that hold it to round trip fidelity.
 *
 * A date chip stores as its ISO day in angle brackets, `<2026-10-01>`, the
 * org-mode date stamp. That reads as the plain date in the API, MCP, email
 * and GitHub sync, GitHub shows it literally because a tag name cannot start
 * with a digit, and the editor and the static renderer both read it back as
 * the chip. Text the person types in that exact shape becomes a chip too.
 */

import type { Editor, JSONContent } from '@tiptap/core';
import { parseVideoEmbed } from '../../lib/videoEmbeds';

/** Fenced code and inline code, which the output clean up must not touch. */
const CODE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/;

/** A run of blank lines longer than the one that separates two blocks. */
const BLANK_RUN = /\n{3,}/g;

/** A link whose text is its own web address. */
const SELF_LINK = /\[(https?:\/\/[^\]\s]+)\]\(\1\)/g;

/** Whether a match stands alone on its line, after any quote markers. */
const aloneOnLine = (source: string, start: number, end: number): boolean => {
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = source.indexOf('\n', end);
  const before = source.slice(lineStart, start);
  const after = source.slice(end, lineEnd === -1 ? source.length : lineEnd);
  return /^(?: {0,3}> ?)* {0,3}$/.test(before) && after.trim() === '';
};

/**
 * The bare address for a link whose text is its own address, except a video
 * link alone on its line, which keeps its brackets so it reads back as the
 * link it was kept as rather than as an embed.
 */
const bareSelfLinks = (part: string): string =>
  part.replace(SELF_LINK, (match: string, url: string, offset: number) =>
    parseVideoEmbed(url) !== null &&
    aloneOnLine(part, offset, offset + match.length)
      ? match
      : url
  );

/**
 * Writes a link whose text is its own address back as the bare address, the
 * way it was typed, since the serializer can only write the bracketed form,
 * unless it is a video link kept as a link on a line of its own, and
 * collapses the blank lines empty paragraphs leave into one, so repeated blank
 * lines in the editor store as a single paragraph break. Code keeps its blank
 * lines.
 */
const tidyOutput = (markdown: string): string =>
  markdown
    .split(CODE)
    .map((part, index) =>
      index % 2 === 1 ? part : bareSelfLinks(part).replace(BLANK_RUN, '\n\n')
    )
    .join('');

/**
 * The editor's document as the Markdown stored for it. Tiptap pads the end of
 * block output with blank lines and opens a leading table with one, which the
 * stored form never carries, so both are trimmed.
 */
export const readMarkdown = (editor: Editor): string =>
  tidyOutput(editor.getMarkdown()).replace(/^\n+/, '').replace(/\s+$/, '');

/**
 * A range of the editor's document as Markdown, written the way the whole
 * document would be, or the empty string for an empty range.
 */
export const readRangeMarkdown = (
  editor: Editor,
  from: number,
  to: number
): string => {
  const manager = editor.markdown;
  if (from >= to || manager === undefined) return '';
  const content = editor.state.doc.slice(from, to).content.toJSON() as
    JSONContent[] | null;
  if (content === null) return '';
  return tidyOutput(manager.serialize({ type: 'doc', content })).trim();
};

/** Replaces the editor's document with a Markdown source, off the undo stack. */
export const writeMarkdown = (editor: Editor, source: string): void => {
  editor
    .chain()
    .setMeta('addToHistory', false)
    .setContent(source, { contentType: 'markdown', emitUpdate: false })
    .run();
};
