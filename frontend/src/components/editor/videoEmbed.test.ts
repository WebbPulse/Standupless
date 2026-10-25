/**
 * Video embeds in the rich editor: a bare video link alone in its paragraph
 * reads as an embed and writes back as the same bare link, a link kept as a
 * link keeps its brackets so it stays one, links anywhere else stay links,
 * and pasting a video link on an empty line embeds it with Escape undoing
 * that into the plain link.
 */

import { Editor } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import { Slice } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../lib/markdown';
import { markdownExtensions } from './markdownExtensions';
import { readMarkdown, writeMarkdown } from './markdownCodec';
import { keepPastedVideoAsLink } from './videoEmbed';

const YOUTUBE = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const LOOM = 'https://www.loom.com/share/0123456789abcdef0123456789abcdef';
const FIGMA =
  'https://www.figma.com/design/aBcDeFgHiJkLmNoPqRsTuV/My-File?node-id=12-34';

const editors: Editor[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.innerHTML = '';
});

/** An editor holding a Markdown source. */
const holding = (source = ''): Editor => {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({ element, extensions: markdownExtensions() });
  editors.push(editor);
  writeMarkdown(editor, source);
  return editor;
};

/** The top level node types of the editor's document. */
const types = (editor: Editor): (string | undefined)[] =>
  (editor.getJSON().content ?? []).map((child: JSONContent) => child.type);

/** Pastes plain text through the editor's paste handlers. */
const paste = (editor: Editor, text: string): boolean => {
  const event = {
    clipboardData: {
      getData: (kind: string) => (kind === 'text/plain' ? text : ''),
    },
    preventDefault: () => undefined,
  } as unknown as ClipboardEvent;
  return (
    editor.view.someProp('handlePaste', (handle) =>
      handle(editor.view, event, Slice.empty)
    ) ?? false
  );
};

describe('video embeds in the Markdown round trip', () => {
  it.each([
    ['alone', YOUTUBE],
    ['between paragraphs', `before\n\n${LOOM}\n\nafter`],
    ['in a quote', `> ${YOUTUBE}`],
    ['two in a row', `${YOUTUBE}\n\n${LOOM}`],
  ])('keep a video link %s byte for byte', (_name, source) => {
    const editor = holding(source);
    expect(readMarkdown(editor)).toBe(source);
    expect(readMarkdown(holding(readMarkdown(editor)))).toBe(source);
  });

  it('read a bare video link alone in its paragraph as an embed', () => {
    const editor = holding(`before\n\n${YOUTUBE}\n\nafter`);
    expect(types(editor)).toEqual(['paragraph', 'videoEmbed', 'paragraph']);
    const embed = editor.getJSON().content?.[1];
    expect(embed?.attrs?.['url']).toBe(YOUTUBE);
  });

  it('leave a video link inside running text a link', () => {
    const editor = holding(`watch ${YOUTUBE} now`);
    expect(types(editor)).toEqual(['paragraph']);
    expect(readMarkdown(editor)).toBe(`watch ${YOUTUBE} now`);
  });

  it('leave a video link continuing a paragraph a link', () => {
    const editor = holding(`line one\n${YOUTUBE}`);
    expect(types(editor)).toEqual(['paragraph']);
  });

  it('leave a video link in a list item a link', () => {
    const editor = holding(`- ${YOUTUBE}`);
    expect(types(editor)[0]).toBe('bulletList');
    expect(types(editor)).not.toContain('videoEmbed');
    expect(readMarkdown(editor)).toBe(`- ${YOUTUBE}`);
  });

  it('leave a link to anything else a link', () => {
    const editor = holding('https://example.com/watch?v=dQw4w9WgXcQ');
    expect(types(editor)).toEqual(['paragraph']);
  });

  it('keep a video link kept as a link in its bracketed form', () => {
    const source = `[${YOUTUBE}](${YOUTUBE})`;
    const editor = holding(source);
    expect(types(editor)).toEqual(['paragraph']);
    expect(readMarkdown(editor)).toBe(source);
  });

  it('write what the static renderer reads as the same embed', () => {
    const editor = holding(`intro\n\n${YOUTUBE}`);
    const blocks = parseMarkdown(readMarkdown(editor));
    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'embed']);
  });
});

describe('pasting a video link', () => {
  it('embeds it on an empty line and selects the embed', () => {
    const editor = holding('');
    expect(paste(editor, ` ${YOUTUBE} `)).toBe(true);
    expect(types(editor)[0]).toBe('videoEmbed');
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(readMarkdown(editor)).toBe(YOUTUBE);
  });

  it('keeps the plain link on Escape right after the paste', () => {
    const editor = holding('');
    paste(editor, YOUTUBE);
    expect(keepPastedVideoAsLink(editor)).toBe(true);
    expect(types(editor)).not.toContain('videoEmbed');
    expect(readMarkdown(editor)).toBe(`[${YOUTUBE}](${YOUTUBE})`);
    expect(parseMarkdown(readMarkdown(editor))[0]?.type).toBe('paragraph');
  });

  it('leaves Escape alone once the embed is no longer the fresh paste', () => {
    const editor = holding('');
    paste(editor, YOUTUBE);
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.atStart(editor.state.doc))
    );
    expect(keepPastedVideoAsLink(editor)).toBe(false);
  });

  it('converts any embed back to a link from its menu', () => {
    const editor = holding(YOUTUBE);
    expect(editor.commands.convertVideoEmbedToLink(0)).toBe(true);
    expect(readMarkdown(editor)).toBe(`[${YOUTUBE}](${YOUTUBE})`);
  });

  it('leaves a paste into a line with text to the link handling', () => {
    const editor = holding('see');
    editor.commands.focus('end');
    expect(paste(editor, YOUTUBE)).toBe(false);
  });

  it('leaves a paste of anything but a video link alone', () => {
    const editor = holding('');
    expect(paste(editor, 'https://example.com')).toBe(false);
  });

  it('never embeds inside a list item', () => {
    const editor = holding('- item');
    editor.commands.setTextSelection(7);
    expect(editor.commands.splitListItem('listItem')).toBe(true);
    expect(paste(editor, YOUTUBE)).toBe(false);
  });
});

describe('Figma links', () => {
  it('keep a Figma link alone in its paragraph byte for byte as an embed', () => {
    const source = `before\n\n${FIGMA}\n\nafter`;
    const editor = holding(source);
    expect(types(editor)).toEqual(['paragraph', 'videoEmbed', 'paragraph']);
    expect(readMarkdown(editor)).toBe(source);
  });

  it('embed on paste and keep the plain link on Escape', () => {
    const editor = holding('');
    expect(paste(editor, FIGMA)).toBe(true);
    expect(types(editor)[0]).toBe('videoEmbed');
    expect(keepPastedVideoAsLink(editor)).toBe(true);
    expect(types(editor)).not.toContain('videoEmbed');
    expect(readMarkdown(editor)).toBe(`[${FIGMA}](${FIGMA})`);
  });

  it('leave an http Figma link a link', () => {
    const editor = holding('');
    expect(paste(editor, FIGMA.replace('https:', 'http:'))).toBe(false);
  });
});
