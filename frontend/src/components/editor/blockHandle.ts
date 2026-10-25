/**
 * Moving blocks around a document, as Linear's editor does. Hovering a block,
 * or a list item at any depth, shows a grip in the left gutter. Dragging the
 * grip picks the block up whole and drops it where the drop line shows, and
 * pressing it opens the block menu the surface draws. Alt+Shift+ArrowUp and
 * Alt+Shift+ArrowDown swap the block at the caret, or the selected blocks,
 * with the one above or below, in one transaction so one undo puts it back.
 *
 * The movable unit is the list item when the caret or pointer is in a list,
 * and otherwise the top-level block, so a callout, a quote or a table moves
 * as a whole. The grip only shows inside an element carrying
 * {@link BLOCK_HANDLES_ATTRIBUTE}, on an editable view with a fine pointer,
 * so read-only renders, comments and touch screens never see it while the
 * keys work on every editable surface.
 */

import { Extension, type Editor, type Range } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/** The attribute on a surface's wrapper that turns the grip on inside it. */
export const BLOCK_HANDLES_ATTRIBUTE = 'data-block-handles';

/** The event the grip fires on the editor's DOM when it is pressed. */
export const BLOCK_MENU_EVENT = 'rich-block-menu';

/** What a press of the grip tells the surface: the block and where it is. */
export interface BlockMenuRequest {
  /** The position just before the block. */
  pos: number;
  /** The grip's box in the viewport, for anchoring the menu under it. */
  anchor: DOMRect;
}

/** The node types a block can be moved within, besides the document. */
const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);

/** The node types that are the movable unit inside a list. */
const ITEM_TYPES = new Set(['listItem', 'taskItem']);

/** The grip's width in pixels, and the gap it keeps from the block. */
const GRIP_WIDTH = 18;
const GRIP_GAP = 4;

/** A block that can be moved, and the position just before it. */
export interface MovableBlock {
  pos: number;
  node: ProseMirrorNode;
}

/**
 * The block a position falls in: the innermost list item holding it, or the
 * top-level block. A position just before a list item or a top-level node,
 * as a hit on its edge or on an atom gives, names that node.
 */
export const movableBlockAt = (
  doc: ProseMirrorNode,
  pos: number
): MovableBlock | null => {
  if (pos < 0 || pos > doc.content.size) return null;
  const $pos = doc.resolve(pos);
  const after = $pos.nodeAfter;
  if (after !== null && ITEM_TYPES.has(after.type.name)) {
    return { pos, node: after };
  }
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (ITEM_TYPES.has(node.type.name)) {
      return { pos: $pos.before(depth), node };
    }
  }
  if ($pos.depth === 0) {
    return after === null ? null : { pos, node: after };
  }
  return { pos: $pos.before(1), node: $pos.node(1) };
};

/**
 * Moves the block at the caret, or the run of sibling blocks the selection
 * covers, one step up or down among its siblings, keeping the selection on
 * it. Answers false when there is no block to move. A block already at the
 * edge of its list or of the document stays put, and the key is still taken
 * so the browser does not extend the selection instead.
 */
export const moveBlocks = (
  state: EditorState,
  dispatch: ((transaction: Transaction) => void) | undefined,
  direction: -1 | 1
): boolean => {
  const { $from, $to } = state.selection;
  const range = $from.blockRange(
    $to,
    (node) => node.type.name === 'doc' || LIST_TYPES.has(node.type.name)
  );
  if (range === null) return false;
  const { parent, startIndex, endIndex } = range;
  if (direction === -1 && startIndex === 0) return true;
  if (direction === 1 && endIndex >= parent.childCount) return true;
  if (dispatch === undefined) return true;
  const transaction = state.tr;
  if (direction === -1) {
    const above = parent.child(startIndex - 1);
    transaction.insert(range.end, above);
    transaction.delete(range.start - above.nodeSize, range.start);
  } else {
    const below = parent.child(endIndex);
    transaction.delete(range.end, range.end + below.nodeSize);
    transaction.insert(range.start, below);
  }
  dispatch(transaction.scrollIntoView());
  return true;
};

/**
 * The span a block's removal must take: a list item that is its list's only
 * item takes the list with it, all the way up, so no empty list is left.
 */
const removalSpan = (
  doc: ProseMirrorNode,
  pos: number
): { from: number; to: number } => {
  let $pos = doc.resolve(pos);
  let node = $pos.nodeAfter;
  let from = pos;
  while (
    node !== null &&
    $pos.depth > 0 &&
    $pos.parent.childCount === 1 &&
    LIST_TYPES.has($pos.parent.type.name)
  ) {
    from = $pos.before();
    node = $pos.parent;
    $pos = doc.resolve(from);
  }
  return { from, to: from + (node?.nodeSize ?? 0) };
};

/** Puts a copy of the block at `pos` right after it. */
export const duplicateBlock = (
  state: EditorState,
  dispatch: ((transaction: Transaction) => void) | undefined,
  pos: number
): boolean => {
  const node = state.doc.nodeAt(pos);
  if (node === null) return false;
  if (dispatch === undefined) return true;
  dispatch(state.tr.insert(pos + node.nodeSize, node.copy(node.content)));
  return true;
};

/** Removes the block at `pos`, and its list when it was the only item. */
export const deleteBlock = (
  state: EditorState,
  dispatch: ((transaction: Transaction) => void) | undefined,
  pos: number
): boolean => {
  if (state.doc.nodeAt(pos) === null) return false;
  if (dispatch === undefined) return true;
  const { from, to } = removalSpan(state.doc, pos);
  dispatch(state.tr.delete(from, to).scrollIntoView());
  return true;
};

/** The block types Turn into can rewrite: text, a list item or a quote. */
const CONVERTIBLE_TYPES = new Set([...ITEM_TYPES, 'blockquote', 'callout']);

/** Whether the block menu offers Turn into for a block. */
export const canTurnInto = (node: ProseMirrorNode): boolean =>
  node.isTextblock || CONVERTIBLE_TYPES.has(node.type.name);

/**
 * Rewrites the block at `pos` as plain text, then, given a slash command's
 * run, as that block type, the way the command would format a fresh line.
 * Every text block inside it is converted, so a quote of two paragraphs
 * becomes two list items rather than one.
 */
export const turnBlockInto = (
  editor: Editor,
  pos: number,
  run: ((editor: Editor, range: Range) => void) | null
): void => {
  const node = editor.state.doc.nodeAt(pos);
  if (node === null) return;
  const end = pos + node.nodeSize;
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.setSelection(
        TextSelection.between(tr.doc.resolve(pos + 1), tr.doc.resolve(end - 1))
      );
      return true;
    })
    .clearNodes()
    .run();
  if (run === null) return;
  const caret = editor.state.selection.from;
  run(editor, { from: caret, to: caret });
};

/** Whether the grip may show for a view right now. */
const handlesAllowed = (view: EditorView): boolean => {
  if (!view.editable) return false;
  if (view.dom.closest(`[${BLOCK_HANDLES_ATTRIBUTE}]`) === null) return false;
  const query = globalThis.matchMedia as typeof matchMedia | undefined;
  if (typeof query !== 'function') return false;
  return query('(hover: hover) and (pointer: fine)').matches;
};

/** The line height an element sets, in pixels. */
const lineHeightOf = (element: HTMLElement): number => {
  const style = getComputedStyle(element);
  const parsed = Number.parseFloat(style.lineHeight);
  if (Number.isFinite(parsed)) return parsed;
  const size = Number.parseFloat(style.fontSize);
  return Number.isFinite(size) ? size * 1.5 : 24;
};

/** The grip, drawn as six dots, and kept outside the editable DOM. */
const createGrip = (): HTMLButtonElement => {
  const grip = document.createElement('button');
  grip.type = 'button';
  grip.className = 'rich-block-grip';
  grip.draggable = true;
  grip.tabIndex = -1;
  grip.setAttribute('aria-label', 'Drag to move, or press for block actions');
  grip.title = 'Drag to move. Click for more.';
  grip.contentEditable = 'false';
  grip.innerHTML =
    '<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true"><circle cx="2.5" cy="3" r="1.25"/><circle cx="7.5" cy="3" r="1.25"/><circle cx="2.5" cy="8" r="1.25"/><circle cx="7.5" cy="8" r="1.25"/><circle cx="2.5" cy="13" r="1.25"/><circle cx="7.5" cy="13" r="1.25"/></svg>';
  return grip;
};

/** Shows the grip beside whatever block the pointer is over. */
class BlockGripView {
  private readonly view: EditorView;
  private readonly grip: HTMLButtonElement;
  private block: MovableBlock | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Builds the grip and starts listening. The grip joins the editor's wrapper
   * the first time it shows, since the editor's DOM may not be mounted yet.
   */
  constructor(view: EditorView) {
    this.view = view;
    this.grip = createGrip();
    view.dom.addEventListener('mousemove', this.onMove);
    view.dom.addEventListener('mouseleave', this.scheduleHide);
    view.dom.addEventListener('keydown', this.hide);
    this.grip.addEventListener('mouseenter', this.cancelHide);
    this.grip.addEventListener('mouseleave', this.scheduleHide);
    this.grip.addEventListener('mousedown', this.onGripMouseDown);
    this.grip.addEventListener('click', this.onGripClick);
    this.grip.addEventListener('dragstart', this.onDragStart);
    this.grip.addEventListener('dragend', this.onDragEnd);
  }

  /** Hides the grip whenever the document changes under it. */
  update(view: EditorView, previous: EditorState): void {
    if (!view.state.doc.eq(previous.doc) && this.block !== null) this.hide();
  }

  /** Takes the grip out and stops listening. */
  destroy(): void {
    this.cancelHide();
    this.view.dom.removeEventListener('mousemove', this.onMove);
    this.view.dom.removeEventListener('mouseleave', this.scheduleHide);
    this.view.dom.removeEventListener('keydown', this.hide);
    this.grip.remove();
  }

  /** Puts the grip away. */
  private readonly hide = (): void => {
    this.cancelHide();
    this.block = null;
    this.grip.removeAttribute('data-visible');
  };

  /**
   * Puts the grip away shortly, so the pointer can cross the gap between the
   * text and the grip without it vanishing.
   */
  private readonly scheduleHide = (): void => {
    this.cancelHide();
    this.hideTimer = setTimeout(this.hide, 150);
  };

  /** Keeps the grip out, as when the pointer reaches it. */
  private readonly cancelHide = (): void => {
    if (this.hideTimer !== undefined) clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
  };

  /** Follows the pointer to the block under it. */
  private readonly onMove = (event: MouseEvent): void => {
    this.cancelHide();
    if (!handlesAllowed(this.view) || this.view.dragging !== null) {
      this.hide();
      return;
    }
    const hit = this.view.posAtCoords({
      left: event.clientX,
      top: event.clientY,
    });
    const block =
      hit === null
        ? null
        : movableBlockAt(
            this.view.state.doc,
            hit.inside >= 0 ? hit.inside : hit.pos
          );
    if (block === null) {
      this.hide();
      return;
    }
    if (block.pos !== this.block?.pos) this.show(block);
  };

  /** Sets the grip beside a block's first line. */
  private show(block: MovableBlock): void {
    const host = this.view.dom.parentElement;
    if (host !== null && this.grip.parentElement !== host)
      host.append(this.grip);
    const element = this.view.nodeDOM(block.pos);
    const parent = this.grip.offsetParent;
    if (!(element instanceof HTMLElement) || parent === null) {
      this.hide();
      return;
    }
    this.block = block;
    const base = parent.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const line =
      element.firstElementChild instanceof HTMLElement &&
      ITEM_TYPES.has(block.node.type.name)
        ? element.firstElementChild
        : element;
    const lineHeight = Math.min(lineHeightOf(line), rect.height || 24);
    const edge = ITEM_TYPES.has(block.node.type.name)
      ? (element.parentElement?.getBoundingClientRect().left ?? rect.left)
      : rect.left;
    const top =
      rect.top -
      base.top -
      parent.clientTop +
      parent.scrollTop +
      lineHeight / 2 -
      12;
    const left =
      edge -
      base.left -
      parent.clientLeft +
      parent.scrollLeft -
      GRIP_WIDTH -
      GRIP_GAP;
    this.grip.style.top = `${String(Math.round(top))}px`;
    this.grip.style.left = `${String(Math.round(left))}px`;
    this.grip.setAttribute('data-visible', '');
  }

  /** Keeps the caret where it is when the grip is pressed. */
  private readonly onGripMouseDown = (event: MouseEvent): void => {
    event.stopPropagation();
  };

  /** Selects the block and asks the surface for its menu. */
  private readonly onGripClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const block = this.block;
    if (block === null) return;
    const { state } = this.view;
    this.view.dispatch(
      state.tr.setSelection(NodeSelection.create(state.doc, block.pos))
    );
    const detail: BlockMenuRequest = {
      pos: block.pos,
      anchor: this.grip.getBoundingClientRect(),
    };
    this.view.dom.dispatchEvent(
      new CustomEvent<BlockMenuRequest>(BLOCK_MENU_EVENT, { detail })
    );
  };

  /** Picks the block up, so the editor's own drop moves it. */
  private readonly onDragStart = (event: DragEvent): void => {
    const block = this.block;
    const transfer = event.dataTransfer;
    if (block === null || transfer === null) {
      event.preventDefault();
      return;
    }
    const { state } = this.view;
    const selection = NodeSelection.create(state.doc, block.pos);
    this.view.dispatch(state.tr.setSelection(selection));
    const slice = selection.content();
    const { dom, text } = this.view.serializeForClipboard(slice);
    transfer.clearData();
    transfer.setData('text/html', dom.innerHTML);
    transfer.setData('text/plain', text);
    transfer.effectAllowed = 'copyMove';
    const element = this.view.nodeDOM(block.pos);
    if (element instanceof HTMLElement) transfer.setDragImage(element, 0, 0);
    this.view.dragging = {
      slice,
      move: true,
      node: selection,
    } as EditorView['dragging'];
  };

  /**
   * Lets go of a drag that ended without a drop in the editor, which the
   * editor would otherwise keep as in flight and so keep the grip hidden.
   */
  private readonly onDragEnd = (): void => {
    const dragging = this.view.dragging;
    this.hide();
    globalThis.setTimeout(() => {
      if (this.view.dragging === dragging) this.view.dragging = null;
    }, 50);
  };
}

/** The extension: the grip and the move keys. */
export const BlockHandle = Extension.create({
  name: 'blockHandle',
  addKeyboardShortcuts() {
    const move = (direction: -1 | 1) => (): boolean =>
      this.editor.isEditable &&
      moveBlocks(this.editor.state, this.editor.view.dispatch, direction);
    return {
      'Alt-Shift-ArrowUp': move(-1),
      'Alt-Shift-ArrowDown': move(1),
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('blockHandle'),
        view: (view) => new BlockGripView(view),
      }),
    ];
  },
});
