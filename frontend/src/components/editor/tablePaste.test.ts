/**
 * Holds spreadsheet paste to Linear's behaviour: tab-separated cells become a
 * table with a header row, quoted cells keep their newlines, and text that is
 * not a grid, or lands in a code block, pastes as it always did.
 */

import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import { markdownExtensions } from './markdownExtensions';
import { readMarkdown, writeMarkdown } from './markdownCodec';
import { parseSpreadsheetText, pasteSpreadsheetTable } from './tablePaste';

const editors: Editor[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.innerHTML = '';
});

/** A mounted editor holding a Markdown source, cursor at the end. */
const editorWith = (source: string): Editor => {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({ element, extensions: markdownExtensions() });
  editors.push(editor);
  writeMarkdown(editor, source);
  return editor;
};

/** A clipboard holding the given plain text and HTML. */
const clipboard = (text: string, html = ''): DataTransfer =>
  ({
    getData: (type: string) =>
      type === 'text/plain' ? text : type === 'text/html' ? html : '',
  }) as unknown as DataTransfer;

/** The text of every cell, row by row, in the document's first table. */
const tableCells = (editor: Editor): string[][] => {
  const rows: string[][] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'tableRow') {
      const cells: string[] = [];
      node.forEach((cell) => cells.push(cell.textContent));
      rows.push(cells);
      return false;
    }
    return true;
  });
  return rows;
};

describe('parseSpreadsheetText', () => {
  it('splits rows and trims cells', () => {
    expect(
      parseSpreadsheetText('Name\t Points \nAda\t3\r\nGrace\t5\n')
    ).toEqual([
      ['Name', 'Points'],
      ['Ada', '3'],
      ['Grace', '5'],
    ]);
  });

  it('keeps a quoted cell with newlines and quotes as one cell', () => {
    expect(
      parseSpreadsheetText('Title\tNotes\nBug\t"line one\nsays ""hi"""')
    ).toEqual([
      ['Title', 'Notes'],
      ['Bug', 'line one\nsays "hi"'],
    ]);
  });

  it('keeps empty cells', () => {
    expect(parseSpreadsheetText('a\t\tc\n\tb\t')).toEqual([
      ['a', '', 'c'],
      ['', 'b', ''],
    ]);
  });

  it('reads a quote inside an unquoted cell as text', () => {
    expect(parseSpreadsheetText('6" pipe\tx\ny\tz')).toEqual([
      ['6" pipe', 'x'],
      ['y', 'z'],
    ]);
  });

  it('refuses text that is not a grid', () => {
    expect(parseSpreadsheetText('a\tb')).toBeNull();
    expect(parseSpreadsheetText('one\ntwo\nthree')).toBeNull();
    expect(parseSpreadsheetText('a\tb\nc')).toBeNull();
    expect(parseSpreadsheetText('a\tb\tc\nd\te')).toBeNull();
    expect(parseSpreadsheetText('')).toBeNull();
  });
});

describe('pasteSpreadsheetTable', () => {
  it('inserts a table with the first row as the header', () => {
    const editor = editorWith('Before');
    const pasted = pasteSpreadsheetTable(
      editor.view,
      clipboard('Name\tPoints\nAda\t3')
    );
    expect(pasted).toBe(true);
    expect(tableCells(editor)).toEqual([
      ['Name', 'Points'],
      ['Ada', '3'],
    ]);
    let headers = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'tableHeader') headers += 1;
    });
    expect(headers).toBe(2);
    const markdown = readMarkdown(editor);
    expect(markdown).toContain('Before');
    expect(markdown).toMatch(/\|\s*Name\s*\|\s*Points\s*\|/);
    expect(markdown).toMatch(/\|\s*Ada\s*\|\s*3\s*\|/);
  });

  it('leaves a clipboard carrying an HTML table to the editor', () => {
    const editor = editorWith('');
    expect(
      pasteSpreadsheetTable(
        editor.view,
        clipboard('a\tb\nc\td', '<table><tr><td>a</td></tr></table>')
      )
    ).toBe(false);
  });

  it('joins the lines of a multi-line cell inside one cell', () => {
    const editor = editorWith('');
    pasteSpreadsheetTable(editor.view, clipboard('a\tb\nc\t"one\ntwo"'));
    expect(tableCells(editor)).toEqual([
      ['a', 'b'],
      ['c', 'one two'],
    ]);
  });

  it('converts when the HTML has no table', () => {
    const editor = editorWith('');
    expect(
      pasteSpreadsheetTable(
        editor.view,
        clipboard('a\tb\nc\td', '<meta charset="utf-8"><span>a b</span>')
      )
    ).toBe(true);
  });

  it('keeps raw text inside a code block', () => {
    const editor = editorWith('```\ncode\n```');
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2))
    );
    expect(pasteSpreadsheetTable(editor.view, clipboard('a\tb\nc\td'))).toBe(
      false
    );
  });

  it('keeps plain text on a plain text paste', () => {
    const editor = editorWith('');
    expect(
      pasteSpreadsheetTable(editor.view, clipboard('a\tb\nc\td'), true)
    ).toBe(false);
  });

  it('leaves text that is not a grid alone', () => {
    const editor = editorWith('');
    expect(pasteSpreadsheetTable(editor.view, clipboard('just a line'))).toBe(
      false
    );
  });
});
