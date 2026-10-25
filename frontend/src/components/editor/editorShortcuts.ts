/**
 * Keyboard chords the stock extensions leave out or bind differently from
 * Linear's editor, so someone used to it finds the same keys here. Bold,
 * italic, strikethrough, inline code on Mod-E, headings on Mod-Alt-1 to 3,
 * the bulleted list on Mod-Shift-8, the quote and the code block on Mod-Alt-C
 * already come with StarterKit. The numbered list moves to Mod-Shift-9 and the
 * checklist to Mod-Shift-7, as in Linear, and Mod-Enter checks the checklist
 * item at the caret. Mod-K for a link is handled by the surface, since it
 * opens the link field.
 */

import { Extension } from '@tiptap/core';
import { OrderedList, TaskList } from '@tiptap/extension-list';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';

/** The task item holding the selection's start, and where it starts. */
const taskItemAt = (
  state: EditorState
): { node: ProseMirrorNode; pos: number } | null => {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === 'taskItem') {
      return { node, pos: $from.before(depth) };
    }
  }
  return null;
};

/**
 * Checks or unchecks the checklist item at the caret, and with `deep` every
 * item nested in it to the same state. Answers false, changing nothing, when
 * the caret is not in a checklist item, so the key keeps its other meaning.
 */
export const toggleChecklistItem = (
  state: EditorState,
  dispatch: ((transaction: Transaction) => void) | undefined,
  deep: boolean
): boolean => {
  const found = taskItemAt(state);
  if (found === null) return false;
  if (dispatch === undefined) return true;
  const checked = found.node.attrs.checked !== true;
  const transaction = state.tr.setNodeMarkup(found.pos, undefined, {
    ...found.node.attrs,
    checked,
  });
  if (deep) {
    found.node.descendants((child, offset) => {
      if (child.type.name !== 'taskItem') return;
      transaction.setNodeMarkup(found.pos + 1 + offset, undefined, {
        ...child.attrs,
        checked,
      });
    });
  }
  dispatch(transaction);
  return true;
};

/** The numbered list, toggled on Mod-Shift-9 as in Linear. */
export const LinearOrderedList = OrderedList.extend({
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-9': () => this.editor.commands.toggleOrderedList(),
    };
  },
});

/** The checklist, toggled on Mod-Shift-7 as in Linear. */
export const LinearTaskList = TaskList.extend({
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-7': () => this.editor.commands.toggleTaskList(),
    };
  },
});

/**
 * The extra chords: a code block on Mod-Shift-Backslash, and Mod-Enter to
 * check the checklist item at the caret, with Shift for its nested items too.
 */
export const EditorShortcuts = Extension.create({
  name: 'editorShortcuts',
  addKeyboardShortcuts() {
    const toggleCodeBlock = (): boolean =>
      this.editor.commands.toggleCodeBlock();
    const check = (deep: boolean) => (): boolean =>
      toggleChecklistItem(this.editor.state, this.editor.view.dispatch, deep);
    return {
      'Mod-Shift-\\': toggleCodeBlock,
      'Mod-Shift-|': toggleCodeBlock,
      'Mod-Enter': check(false),
      'Mod-Shift-Enter': check(true),
    };
  },
});
