/**
 * The emoji menu a `:` shortcode opens, as in Linear. Typing a colon at the
 * start of a block, after a space or after an opening bracket or quote, then
 * two or more shortcode characters, lists the emoji whose shortcode or keyword
 * starts with what was typed, recently used ones first. The arrows move the
 * highlight, Enter or Tab inserts the emoji, Escape closes the menu for that
 * colon, and typing the closing colon of an exact shortcode inserts it
 * directly. Nothing opens in code, in a link or right after a word, so times
 * like `10:30` and URLs stay as typed.
 *
 * The emoji goes in as its Unicode character, which is what the Markdown
 * stores, so nothing new has to round trip. The menu is drawn by the plugin
 * itself, with the same classes as the mention and reference menus, so a
 * surface gains it by registering the extension and nothing else.
 */

import { Extension } from '@tiptap/core';
import {
  Plugin,
  PluginKey,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import {
  findShortcode,
  loadedShortcodeCatalog,
  loadShortcodeCatalog,
  recentEmoji,
  rememberEmoji,
  searchShortcodes,
  type EmojiEntry,
} from '../../lib/emojiCatalog';

/** The shortcode being typed: where its colon sits in the block, and the code. */
export interface EmojiQuery {
  start: number;
  query: string;
}

/** What the plugin holds between transactions. */
export interface EmojiSuggestionState {
  from: number;
  to: number;
  query: string;
  items: EmojiEntry[];
  highlight: number;
  dismissed: number | null;
}

/** A change the plugin is asked to make by meta. */
type EmojiAction =
  | { type: 'move'; step: number }
  | { type: 'highlight'; index: number }
  | { type: 'dismiss' }
  | { type: 'refresh' };

/** The plugin's key, for reading its state from outside. */
export const emojiSuggestionKey = new PluginKey<EmojiSuggestionState>(
  'emojiSuggestion'
);

/** The width the menu is drawn at, for keeping it inside the surface. */
const MENU_WIDTH = 256;

/** The shortcode a block's text ends in, with the rules on what may precede it. */
const SHORTCODE = /(^|[\s([{"'])(:([\w+-]{2,32}))$/u;

/**
 * The shortcode the caret is at the end of, or null. The colon must start the
 * text or follow whitespace or an opening bracket or quote, and at least two
 * shortcode characters must follow it.
 */
export const emojiQuery = (before: string): EmojiQuery | null => {
  const match = SHORTCODE.exec(before);
  const query = match?.[3];
  if (match === null || query === undefined) return null;
  return { start: before.length - query.length - 1, query };
};

/** The state with no menu open. */
const closed: EmojiSuggestionState = {
  from: 0,
  to: 0,
  query: '',
  items: [],
  highlight: 0,
  dismissed: null,
};

/** The shortcode at the caret in an editor state, as document positions. */
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
  const typed = emojiQuery(before);
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
  held: EmojiSuggestionState,
  state: EditorState
): EmojiSuggestionState => {
  const action = transaction.getMeta(emojiSuggestionKey) as
    EmojiAction | undefined;
  const typed = typedAt(state);
  if (typed === null) return closed;
  const dismissed =
    action?.type === 'dismiss'
      ? typed.from
      : held.dismissed === typed.from
        ? held.dismissed
        : null;
  if (dismissed !== null) return { ...closed, dismissed };
  const catalog = loadedShortcodeCatalog();
  const items =
    catalog === null
      ? []
      : searchShortcodes(catalog, typed.query, recentEmoji());
  const sameQuery = held.query === typed.query && held.from === typed.from;
  let highlight = sameQuery ? held.highlight : 0;
  if (action?.type === 'move' && items.length > 0) {
    highlight = (highlight + action.step + items.length) % items.length;
  }
  if (action?.type === 'highlight') highlight = action.index;
  highlight = Math.min(highlight, Math.max(0, items.length - 1));
  return { ...typed, items, highlight, dismissed: null };
};

/** Whether the menu is showing for a state. */
const isOpen = (held: EmojiSuggestionState | undefined): boolean =>
  held !== undefined && held.items.length > 0;

/** Replaces the typed shortcode with an emoji and remembers it as used. */
const insertEmoji = (
  view: EditorView,
  entry: EmojiEntry,
  from: number,
  to: number
): void => {
  rememberEmoji(entry.emoji);
  view.dispatch(view.state.tr.insertText(entry.emoji, from, to));
};

/** Sends the plugin an action. */
const act = (view: EditorView, action: EmojiAction): void => {
  view.dispatch(view.state.tr.setMeta(emojiSuggestionKey, action));
};

/** Draws the menu's rows into its listbox. */
const drawRows = (
  list: HTMLUListElement,
  held: EmojiSuggestionState,
  view: EditorView
): void => {
  list.replaceChildren(
    ...held.items.map((entry, index) => {
      const row = document.createElement('li');
      const selected = index === held.highlight;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(selected));
      row.dataset.emoji = entry.emoji;
      row.className = [
        'flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm hover:bg-raised hover:text-text active:bg-line',
        selected ? 'bg-raised text-text' : 'text-text-muted',
      ].join(' ');
      const glyph = document.createElement('span');
      glyph.className = 'w-5 shrink-0 text-center text-base leading-none';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = entry.emoji;
      const code = document.createElement('span');
      code.className = 'min-w-0 flex-1 truncate text-text';
      code.textContent = `:${entry.shortcodes?.[0] ?? entry.label}:`;
      row.append(glyph, code);
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        const now = emojiSuggestionKey.getState(view.state);
        if (isOpen(now) && now !== undefined) {
          insertEmoji(view, entry, now.from, now.to);
        }
      });
      row.addEventListener('mouseenter', () => {
        if (emojiSuggestionKey.getState(view.state)?.highlight !== index) {
          act(view, { type: 'highlight', index });
        }
      });
      return row;
    })
  );
  const current = list.children[held.highlight];
  if (typeof current?.scrollIntoView === 'function') {
    current.scrollIntoView({ block: 'nearest' });
  }
};

/** Places the menu under the shortcode's colon, inside the surface. */
const placeMenu = (
  list: HTMLUListElement,
  view: EditorView,
  from: number
): void => {
  const host = (list.offsetParent ?? list.parentElement) as HTMLElement | null;
  if (host === null) return;
  const box = host.getBoundingClientRect();
  let top = 0;
  let left = 0;
  try {
    const caret = view.coordsAtPos(from);
    top = caret.bottom - box.top + 4;
    left = Math.max(0, Math.min(caret.left - box.left, box.width - MENU_WIDTH));
  } catch {
    top = 0;
  }
  list.style.top = `${String(top)}px`;
  list.style.left = `${String(left)}px`;
};

/** The menu's element, kept beside the editable surface while it is shown. */
const createMenuView = (view: EditorView) => {
  const list = document.createElement('ul');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Insert an emoji');
  list.className =
    'absolute z-20 max-h-72 w-64 overflow-y-auto rounded-md border border-line bg-overlay py-1 shadow-overlay';
  let destroyed = false;
  let loading = false;
  let drawn: EmojiSuggestionState | null = null;

  const update = (current: EditorView): void => {
    const held = emojiSuggestionKey.getState(current.state);
    if (
      !loading &&
      held !== undefined &&
      held.query !== '' &&
      loadedShortcodeCatalog() === null
    ) {
      loading = true;
      void loadShortcodeCatalog()
        .then(() => {
          if (!destroyed) act(current, { type: 'refresh' });
        })
        .catch(() => undefined)
        .finally(() => {
          loading = false;
        });
    }
    if (!current.editable || !isOpen(held) || held === undefined) {
      list.remove();
      drawn = null;
      return;
    }
    const parent = current.dom.parentElement;
    if (parent === null) return;
    if (list.parentElement !== parent) parent.append(list);
    if (drawn !== held) {
      drawRows(list, held, current);
      drawn = held;
    }
    placeMenu(list, current, held.from);
  };

  update(view);
  return {
    update,
    destroy: () => {
      destroyed = true;
      list.remove();
    },
  };
};

/** Answers a key while the menu is open, or false to let the editor have it. */
const handleKey = (view: EditorView, event: KeyboardEvent): boolean => {
  const held = emojiSuggestionKey.getState(view.state);
  if (!view.editable || !isOpen(held) || held === undefined) return false;
  const mod = event.metaKey || event.ctrlKey;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    act(view, { type: 'move', step: event.key === 'ArrowDown' ? 1 : -1 });
    return true;
  }
  if (
    (event.key === 'Enter' && !mod && !event.shiftKey) ||
    event.key === 'Tab'
  ) {
    const entry = held.items[held.highlight];
    if (entry === undefined) return false;
    event.preventDefault();
    insertEmoji(view, entry, held.from, held.to);
    return true;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    act(view, { type: 'dismiss' });
    return true;
  }
  return false;
};

/**
 * Inserts the emoji a closing colon finishes, when what precedes it is an
 * exact shortcode, and answers whether it did.
 */
const handleClosingColon = (
  view: EditorView,
  from: number,
  to: number,
  text: string
): boolean => {
  if (text !== ':' || from !== to) return false;
  const catalog = loadedShortcodeCatalog();
  const typed = typedAt(view.state);
  if (catalog === null || typed === null || typed.to !== from) return false;
  const entry = findShortcode(catalog, typed.query);
  if (entry === undefined) return false;
  insertEmoji(view, entry, typed.from, typed.to);
  return true;
};

/** The `:` shortcode emoji menu, for every rich Markdown surface. */
export const EmojiSuggestion = Extension.create({
  name: 'emojiSuggestion',
  addProseMirrorPlugins() {
    return [
      new Plugin<EmojiSuggestionState>({
        key: emojiSuggestionKey,
        state: {
          init: () => closed,
          apply: (transaction, held, _old, state) =>
            nextState(transaction, held, state),
        },
        view: createMenuView,
        props: {
          handleDOMEvents: {
            keydown: handleKey,
            blur: (view) => {
              if (isOpen(emojiSuggestionKey.getState(view.state))) {
                act(view, { type: 'dismiss' });
              }
              return false;
            },
          },
          handleTextInput: handleClosingColon,
        },
      }),
    ];
  },
});
