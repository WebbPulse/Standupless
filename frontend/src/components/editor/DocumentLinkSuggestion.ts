/**
 * The `[[` document picker's trigger and keys, as in Linear. Typing two
 * opening brackets opens a picker of the workspace's documents under the
 * caret, searching by the title typed after them. The arrows move the
 * highlight, Enter or Tab picks, Ctrl or Cmd Enter picks and opens the
 * document in a new tab, and Escape, a closing bracket or leaving the surface
 * closes the picker and keeps the text as typed. Nothing opens in code or in
 * a link.
 *
 * The plugin only tracks the query and the highlight. The list, the reads and
 * the writes belong to the menu that registers itself as the picker of an
 * editor, so a surface without a workspace keeps `[[` as plain text.
 */

import { Extension, type Editor } from '@tiptap/core';
import {
  Plugin,
  PluginKey,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/** The document title being typed: where its `[[` sits in the block. */
export interface DocumentLinkQuery {
  start: number;
  query: string;
}

/** What the plugin holds between transactions. */
export interface DocumentLinkState {
  open: boolean;
  from: number;
  to: number;
  query: string;
  highlight: number;
  dismissed: number | null;
}

/** What answers the picker's keys: the menu drawing it. */
export interface DocumentLinkPicker {
  /** How many rows the menu shows right now. */
  count: () => number;
  /** Picks a row, opening what it links in a new tab when asked. */
  choose: (index: number, openInNewTab: boolean) => void;
}

/** A change the plugin is asked to make by meta. */
type DocumentLinkAction =
  { type: 'highlight'; index: number } | { type: 'dismiss' };

/** The plugin's key, for reading its state from outside. */
export const documentLinkKey = new PluginKey<DocumentLinkState>('documentLink');

/** The longest title the trigger keeps reading. */
const QUERY_MAX = 120;

/** A `[[` the block's text ends in, with no bracket or break after it. */
const TYPED = new RegExp(`\\[\\[([^\\[\\]\\n]{0,${String(QUERY_MAX)}})$`, 'u');

/** The picker each editor's menu registered. */
const pickers = new WeakMap<Editor, DocumentLinkPicker>();

/** Makes a menu the picker of an editor, and answers how to undo it. */
export const registerDocumentLinkPicker = (
  editor: Editor,
  picker: DocumentLinkPicker
): (() => void) => {
  pickers.set(editor, picker);
  return () => {
    if (pickers.get(editor) === picker) pickers.delete(editor);
  };
};

/** The `[[` query the caret is at the end of, or null. */
export const documentLinkQuery = (before: string): DocumentLinkQuery | null => {
  const match = TYPED.exec(before);
  const query = match?.[1];
  if (match === null || query === undefined) return null;
  return { start: before.length - query.length - 2, query };
};

/** The state with no picker open. */
export const closedDocumentLink: DocumentLinkState = {
  open: false,
  from: 0,
  to: 0,
  query: '',
  highlight: 0,
  dismissed: null,
};

/** The `[[` query at the caret in an editor state, as document positions. */
const typedAt = (
  state: EditorState
): { from: number; to: number; query: string } | null => {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  if ($from.parent.type.spec.code === true) return null;
  const marks = state.storedMarks ?? $from.marks();
  if (marks.some((mark) => ['code', 'link'].includes(mark.type.name))) {
    return null;
  }
  const before = $from.parent.textBetween(
    0,
    $from.parentOffset,
    undefined,
    '￼'
  );
  const typed = documentLinkQuery(before);
  if (typed === null) return null;
  return {
    from: $from.pos - (before.length - typed.start),
    to: $from.pos,
    query: typed.query,
  };
};

/** The plugin state after a transaction. */
const nextState = (
  transaction: Transaction,
  held: DocumentLinkState,
  state: EditorState
): DocumentLinkState => {
  const action = transaction.getMeta(documentLinkKey) as
    DocumentLinkAction | undefined;
  const typed = typedAt(state);
  if (typed === null) return closedDocumentLink;
  const dismissed =
    action?.type === 'dismiss'
      ? typed.from
      : held.dismissed === typed.from
        ? held.dismissed
        : null;
  if (dismissed !== null) return { ...closedDocumentLink, dismissed };
  const sameQuery =
    held.open && held.query === typed.query && held.from === typed.from;
  const highlight =
    action?.type === 'highlight'
      ? action.index
      : sameQuery
        ? held.highlight
        : 0;
  if (sameQuery && held.to === typed.to && highlight === held.highlight) {
    return held;
  }
  return { open: true, ...typed, highlight, dismissed: null };
};

/** Sends the plugin an action. */
export const actOnDocumentLink = (
  view: EditorView,
  action: DocumentLinkAction
): void => {
  view.dispatch(view.state.tr.setMeta(documentLinkKey, action));
};

/** Answers a key while the picker is open, or false to let the editor have it. */
const handleKey = (
  editor: Editor,
  view: EditorView,
  event: KeyboardEvent
): boolean => {
  const held = documentLinkKey.getState(view.state);
  const picker = pickers.get(editor);
  if (!view.editable || held?.open !== true || picker === undefined) {
    return false;
  }
  const count = picker.count();
  const current = Math.min(held.highlight, Math.max(0, count - 1));
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    actOnDocumentLink(view, { type: 'dismiss' });
    return true;
  }
  if (count === 0) return false;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    actOnDocumentLink(view, {
      type: 'highlight',
      index: (current + step + count) % count,
    });
    return true;
  }
  if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
    event.preventDefault();
    event.stopPropagation();
    picker.choose(
      current,
      event.key === 'Enter' && (event.metaKey || event.ctrlKey)
    );
    return true;
  }
  return false;
};

/** The `[[` document picker's trigger, for every rich Markdown surface. */
export const DocumentLinkSuggestion = Extension.create({
  name: 'documentLinkSuggestion',
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin<DocumentLinkState>({
        key: documentLinkKey,
        state: {
          init: () => closedDocumentLink,
          apply: (transaction, held, _old, state) =>
            nextState(transaction, held, state),
        },
        props: {
          handleDOMEvents: {
            keydown: (view, event) => handleKey(editor, view, event),
            blur: (view) => {
              if (documentLinkKey.getState(view.state)?.open === true) {
                actOnDocumentLink(view, { type: 'dismiss' });
              }
              return false;
            },
          },
        },
      }),
    ];
  },
});
