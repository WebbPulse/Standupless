/**
 * Reading and writing Markdown through the editor schema, shared by the live
 * editor and by the tests that hold it to round trip fidelity.
 */

import type { Editor } from '@tiptap/core';

/** Fenced code and inline code, which the output clean up must not touch. */
const CODE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/;

/** A link whose text is its own web address. */
const SELF_LINK = /\[(https?:\/\/[^\]\s]+)\]\(\1\)/g;

/**
 * Writes a link whose text is its own address back as the bare address, the
 * way it was typed, since the serializer can only write the bracketed form.
 */
const collapseSelfLinks = (markdown: string): string =>
  markdown
    .split(CODE)
    .map((part, index) =>
      index % 2 === 1 ? part : part.replace(SELF_LINK, '$1')
    )
    .join('');

/**
 * The editor's document as the Markdown stored for it. Tiptap pads the end of
 * block output with blank lines and opens a leading table with one, which the
 * stored form never carries, so both are trimmed.
 */
export const readMarkdown = (editor: Editor): string =>
  collapseSelfLinks(editor.getMarkdown())
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');

/** Replaces the editor's document with a Markdown source, off the undo stack. */
export const writeMarkdown = (editor: Editor, source: string): void => {
  editor
    .chain()
    .setMeta('addToHistory', false)
    .setContent(source, { contentType: 'markdown', emitUpdate: false })
    .run();
};
