/**
 * The `|--` table shortcut, as Linear has it: typing `|--` at the start of an
 * empty paragraph swaps it for the same table the `/table` command inserts,
 * with a header row and the caret in its first cell. Inside a table cell the
 * text stays as typed, since a table cannot hold another.
 */

import type { ChainedCommands } from '@tiptap/core';
import { Extension, InputRule } from '@tiptap/core';

/** The table the shortcut and the slash command both insert. */
export const STARTER_TABLE = { rows: 3, cols: 3, withHeaderRow: true };

/** Adds the starter table to a chain, at the selection. */
export const insertStarterTable = (chain: ChainedCommands): ChainedCommands =>
  chain.insertTable(STARTER_TABLE);

/** The cells a typed `|--` stays text in. */
const CELLS = new Set(['tableCell', 'tableHeader']);

/** The `|--` input rule. */
export const TableShortcut = Extension.create({
  name: 'tableShortcut',

  addInputRules() {
    return [
      new InputRule({
        find: /^\|--$/,
        handler: ({ state, range, chain }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.name !== 'paragraph') return null;
          if ($from.parent.textContent.length !== range.to - range.from) {
            return null;
          }
          for (let depth = $from.depth; depth > 0; depth -= 1) {
            if (CELLS.has($from.node(depth).type.name)) return null;
          }
          return insertStarterTable(chain().deleteRange(range)).run()
            ? undefined
            : null;
        },
      }),
    ];
  },
});
