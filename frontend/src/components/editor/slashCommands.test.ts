/**
 * Holds the `/` insert menu to when it opens, what it lists for a query, and
 * the Markdown each block writes. Every block a pick inserts stores as the
 * text its Markdown shortcut would, and reads back byte for byte.
 */

import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MERMAID_STARTER } from '../../lib/mermaid';
import { markdownExtensions } from './markdownExtensions';
import { readMarkdown, writeMarkdown } from './markdownCodec';
import {
  SLASH_COMMANDS,
  filterSlashCommands,
  slashQuery,
  type SlashContext,
} from './slashCommands';

vi.mock('../../lib/mermaid', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/mermaid')>()),
  renderMermaid: vi.fn(() => Promise.resolve({ ok: true, svg: '<svg></svg>' })),
}));

const editors: Editor[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.innerHTML = '';
});

/** A mounted editor whose only paragraph is the typed slash query. */
const editorTyping = (typed: string): Editor => {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({ element, extensions: markdownExtensions() });
  editors.push(editor);
  writeMarkdown(editor, typed);
  editor.commands.setTextSelection(typed.length + 1);
  return editor;
};

/** The ids a query lists for a surface. */
const ids = (query: string, context: SlashContext = {}): string[] =>
  filterSlashCommands(query, context).map((command) => command.id);

describe('slashQuery', () => {
  it('opens on a slash that starts the line', () => {
    expect(slashQuery('/')).toEqual({ start: 0, query: '' });
    expect(slashQuery('/hea')).toEqual({ start: 0, query: 'hea' });
  });

  it('opens on a slash after a space', () => {
    expect(slashQuery('see /code')).toEqual({ start: 4, query: 'code' });
  });

  it('stays shut inside a path, a URL or after a space in the query', () => {
    expect(slashQuery('src/app')).toBeNull();
    expect(slashQuery('https://example.com/')).toBeNull();
    expect(slashQuery('/code block')).toBeNull();
    expect(slashQuery('a//')).toBeNull();
  });
});

describe('filterSlashCommands', () => {
  it('lists every block for a bare slash, leaving out what the surface lacks', () => {
    expect(ids('')).toEqual([
      'heading1',
      'heading2',
      'heading3',
      'bulletList',
      'orderedList',
      'taskList',
      'blockquote',
      'codeBlock',
      'diagram',
      'collapsible',
      'callout',
      'divider',
      'table',
      'equation',
      'inlineEquation',
    ]);
  });

  it('offers uploads and mentions only where the surface has them', () => {
    const all = ids('', { pickFiles: () => undefined, mentions: true });
    expect(all).toContain('attachment');
    expect(all).toContain('mention');
    expect(ids('image')).toEqual([]);
    expect(ids('image', { pickFiles: () => undefined })).toEqual([
      'attachment',
    ]);
  });

  it('narrows as the query grows', () => {
    expect(ids('h')).toEqual([
      'heading1',
      'heading2',
      'heading3',
      'divider',
      'taskList',
    ]);
    expect(ids('head')).toEqual(['heading1', 'heading2', 'heading3']);
    expect(ids('h2')).toEqual(['heading2']);
    expect(ids('todo')).toEqual(['taskList']);
    expect(ids('LIST')).toEqual(['bulletList', 'orderedList', 'taskList']);
    expect(ids('zzz')).toEqual([]);
  });

  it('puts a label match ahead of a keyword match', () => {
    expect(ids('code')[0]).toBe('codeBlock');
    expect(ids('quote')).toEqual(['blockquote']);
    expect(ids('div')).toEqual(['divider']);
    expect(ids('toggle')).toEqual(['collapsible']);
    expect(ids('details')).toEqual(['collapsible']);
    expect(ids('callout')).toEqual(['callout']);
    expect(ids('warning')).toEqual(['callout']);
    expect(ids('tip')).toEqual(['callout']);
  });
});

const WRITES: [string, string][] = [
  ['heading1', '# Plan'],
  ['heading2', '## Plan'],
  ['heading3', '### Plan'],
  ['bulletList', '- Plan'],
  ['orderedList', '1. Plan'],
  ['taskList', '- [ ] Plan'],
  ['blockquote', '> Plan'],
  ['codeBlock', '```\nPlan\n```'],
  ['collapsible', '<details>\n<summary>Plan</summary>\n\n</details>'],
  ['callout', '> [!NOTE]\n> Plan'],
  ['divider', '---\n\nPlan'],
];

/** The command with an id, which every listed id has. */
const command = (id: string): (typeof SLASH_COMMANDS)[number] => {
  const found = SLASH_COMMANDS.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no command ${id}`);
  return found;
};

describe('running a command', () => {
  it.each(WRITES)(
    'replaces the slash with %s and stores its Markdown',
    (id, written) => {
      const editor = editorTyping('/x');
      command(id).run(editor, { from: 1, to: 3 }, {});
      editor.commands.insertContent('Plan');
      expect(readMarkdown(editor)).toBe(written);
      writeMarkdown(editor, written);
      expect(readMarkdown(editor)).toBe(written);
    }
  );

  it('inserts a table that reads back unchanged', () => {
    const editor = editorTyping('/table');
    command('table').run(editor, { from: 1, to: 7 }, {});
    editor.commands.insertContent('Owner');
    const written = readMarkdown(editor);
    expect(written).toContain('| Owner');
    expect(written).not.toContain('/table');
    writeMarkdown(editor, written);
    expect(readMarkdown(editor)).toBe(written);
  });

  it('makes a collapsible section titled by the rest of the line', () => {
    const editor = editorTyping('Note /col');
    command('collapsible').run(editor, { from: 6, to: 10 }, {});
    editor.commands.insertContent('Plan');
    expect(readMarkdown(editor)).toBe(
      '<details>\n<summary>Note Plan</summary>\n\n</details>'
    );
    expect(editor.state.selection.$from.parent.type.name).toBe(
      'collapsibleSummary'
    );
  });

  it('inserts a Mermaid block holding the starter graph', () => {
    const editor = editorTyping('/diagram');
    command('diagram').run(editor, { from: 1, to: 9 }, {});
    const written = readMarkdown(editor);
    expect(written).toBe(`\`\`\`mermaid\n${MERMAID_STARTER}\n\`\`\``);
    writeMarkdown(editor, written);
    expect(readMarkdown(editor)).toBe(written);
  });

  it('finds the diagram block by its keywords', () => {
    expect(ids('mermaid')).toEqual(['diagram']);
    expect(ids('flow')).toEqual(['diagram']);
    expect(ids('diag')).toEqual(['diagram']);
  });

  it('inserts a block equation in place of the slash', () => {
    const editor = editorTyping('/equation');
    command('equation').run(editor, { from: 1, to: 10 }, {});
    const types: string[] = [];
    editor.state.doc.forEach((node) => types.push(node.type.name));
    expect(types).toContain('blockMath');
    expect(editor.getText()).not.toContain('/equation');
  });

  it('inserts an inline equation in place of the slash', () => {
    const editor = editorTyping('Area /eq');
    command('inlineEquation').run(editor, { from: 6, to: 9 }, {});
    const types: string[] = [];
    editor.state.doc.descendants((node) => {
      types.push(node.type.name);
    });
    expect(types).toContain('inlineMath');
  });

  it('finds the equations by their keywords', () => {
    expect(ids('equ')).toEqual(['equation', 'inlineEquation']);
    expect(ids('latex')).toEqual(['equation', 'inlineEquation']);
    expect(ids('math')).toEqual(['equation', 'inlineEquation']);
  });

  it('starts a mention in place of the slash', () => {
    const editor = editorTyping('Ask /men');
    command('mention').run(editor, { from: 5, to: 9 }, { mentions: true });
    expect(readMarkdown(editor)).toBe('Ask @');
  });

  it('offers /date only where the surface has a date picker', () => {
    expect(ids('date')).toEqual([]);
    expect(ids('date', { pickDate: () => undefined })).toEqual(['date']);
    expect(ids('tomorrow', { pickDate: () => undefined })).toEqual(['date']);
  });

  it('clears the slash and opens the date picker for /date', () => {
    const pickDate = vi.fn();
    const editor = editorTyping('Due /date');
    command('date').run(editor, { from: 5, to: 10 }, { pickDate });
    expect(pickDate).toHaveBeenCalledTimes(1);
    expect(readMarkdown(editor).trimEnd()).toBe('Due');
  });

  it('starts the diagram as a top down graph', () => {
    expect(MERMAID_STARTER.split('\n')[0]).toBe('graph TD');
    expect(ids('chart')).toEqual(['diagram']);
  });

  it('clears the slash and opens the file picker for an upload', () => {
    const pickFiles = vi.fn();
    const editor = editorTyping('/image');
    command('attachment').run(editor, { from: 1, to: 7 }, { pickFiles });
    expect(pickFiles).toHaveBeenCalledTimes(1);
    expect(readMarkdown(editor)).toBe('');
  });
});
