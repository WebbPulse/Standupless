/**
 * Pasting cells copied from a spreadsheet makes a table, as it does in Linear.
 * Google Sheets, Excel and Numbers put the cells on the clipboard as
 * tab-separated text; when no HTML table rides along, that text is read here
 * and inserted as a table whose first row is the header row. Inside a code
 * block, inside a table, and on Ctrl/Cmd+Shift+V the text pastes unchanged.
 */

import { Extension } from '@tiptap/core';
import type {
  Node as ProseMirrorNode,
  NodeType,
  Schema,
} from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/**
 * Splits tab-separated text into rows of trimmed cells, or returns null when
 * it is not a grid: fewer than two rows, no tab, or rows of differing width.
 * A cell wrapped in double quotes keeps its tabs and newlines, with `""`
 * standing for one quote, as spreadsheets write them.
 */
export const parseSpreadsheetText = (text: string): string[][] | null => {
  const source = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let index = 0;
  let atCellStart = true;
  while (index < source.length) {
    const char = source.charAt(index);
    if (atCellStart && char === '"') {
      const close = closingQuote(source, index + 1);
      if (close !== -1) {
        cell = source.slice(index + 1, close).replace(/""/g, '"');
        index = close + 1;
        atCellStart = false;
        continue;
      }
    }
    atCellStart = false;
    if (char === '\t') {
      row.push(cell.trim());
      cell = '';
      atCellStart = true;
    } else if (char === '\n') {
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = '';
      atCellStart = true;
    } else {
      cell += char;
    }
    index += 1;
  }
  row.push(cell.trim());
  rows.push(row);
  const width = rows[0]?.length ?? 0;
  if (rows.length < 2 || width < 2) return null;
  if (rows.some((cells) => cells.length !== width)) return null;
  return rows;
};

/**
 * The index of the quote closing a quoted cell opened before `from`, or -1
 * when the quote is not followed by a tab, a newline or the end of the text.
 */
const closingQuote = (source: string, from: number): number => {
  let index = from;
  while (index < source.length) {
    if (source[index] === '"') {
      if (source[index + 1] === '"') {
        index += 2;
        continue;
      }
      const next = source[index + 1];
      return next === undefined || next === '\t' || next === '\n' ? index : -1;
    }
    index += 1;
  }
  return -1;
};

/**
 * A table node holding the rows, the first as header cells. A cell's line
 * breaks become spaces, since a Markdown table row is one line.
 */
export const spreadsheetTable = (
  schema: Schema,
  rows: string[][]
): ProseMirrorNode | null => {
  const { table, tableRow, tableHeader, tableCell, paragraph } = schema.nodes;
  if (!table || !tableRow || !tableHeader || !tableCell || !paragraph) {
    return null;
  }
  const cellNode = (type: NodeType, text: string) => {
    const line = text.replace(/\s*\n\s*/g, ' ');
    return type.create(
      null,
      paragraph.create(null, line === '' ? null : schema.text(line))
    );
  };
  return table.create(
    null,
    rows.map((cells, rowIndex) =>
      tableRow.create(
        null,
        cells.map((text) =>
          cellNode(rowIndex === 0 ? tableHeader : tableCell, text)
        )
      )
    )
  );
};

/** Whether the selection sits where pasted text must stay raw. */
const keepsRawText = (view: EditorView): boolean => {
  const { $from } = view.state.selection;
  if ($from.parent.type.spec.code === true) return true;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.spec['tableRole'] === 'table') return true;
  }
  return false;
};

/**
 * Inserts the clipboard's spreadsheet cells as a table and reports whether it
 * did; anything else is left to the editor's own paste.
 */
export const pasteSpreadsheetTable = (
  view: EditorView,
  clipboard: DataTransfer | null,
  plainText = false
): boolean => {
  if (clipboard === null || plainText || !view.editable) return false;
  if (/<table[\s>]/i.test(clipboard.getData('text/html'))) return false;
  const rows = parseSpreadsheetText(clipboard.getData('text/plain'));
  if (rows === null || keepsRawText(view)) return false;
  const table = spreadsheetTable(view.state.schema, rows);
  if (table === null) return false;
  view.dispatch(view.state.tr.replaceSelectionWith(table).scrollIntoView());
  return true;
};

const spreadsheetPasteKey = new PluginKey('spreadsheetPaste');

/** The editor extension that turns pasted spreadsheet cells into a table. */
export const SpreadsheetPaste = Extension.create({
  name: 'spreadsheetPaste',

  addProseMirrorPlugins() {
    let shiftHeld = false;
    return [
      new Plugin({
        key: spreadsheetPasteKey,
        props: {
          handleDOMEvents: {
            keydown: (_view, event) => {
              shiftHeld = event.shiftKey;
              return false;
            },
            keyup: (_view, event) => {
              shiftHeld = event.shiftKey;
              return false;
            },
            blur: () => {
              shiftHeld = false;
              return false;
            },
          },
          handlePaste: (view, event) => {
            if (!pasteSpreadsheetTable(view, event.clipboardData, shiftHeld)) {
              return false;
            }
            event.preventDefault();
            return true;
          },
        },
      }),
    ];
  },
});
