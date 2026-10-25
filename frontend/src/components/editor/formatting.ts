/**
 * The formatting a rich Markdown surface offers from its selection toolbar,
 * each with the keys that do the same thing. Every action maps onto a node or
 * mark the Markdown dialect already reads and writes, so the toolbar adds a
 * way to reach the formatting and never a new kind of stored text.
 *
 * Actions are plain data in groups, so the toolbar draws whatever is listed
 * here and a new action is one more entry.
 */

import type { Editor } from '@tiptap/core';
import { PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import type { IconType } from 'react-icons';
import {
  LuBold,
  LuCode,
  LuHeading1,
  LuHeading2,
  LuHeading3,
  LuItalic,
  LuLink,
  LuList,
  LuListOrdered,
  LuListTodo,
  LuSquareCode,
  LuStrikethrough,
  LuTextQuote,
} from 'react-icons/lu';
import {
  altKeyLabel,
  isApplePlatform,
  modKeyLabel,
  shiftKeyLabel,
} from '../../lib/platform';

/** The selection toolbar's plugin, so the surface can hide it on demand. */
export const formattingToolbarKey = new PluginKey('formattingToolbar');

/**
 * Whether the selection toolbar belongs over the current selection: text is
 * selected in an editable, focused surface, outside a code block, where marks
 * mean nothing. A table cell selection or a selected image gets no toolbar.
 */
export const shouldShowToolbar = (
  editor: Editor,
  state: EditorState,
  focused: boolean
): boolean => {
  const { selection } = state;
  if (!editor.isEditable || !focused || selection.empty) return false;
  if (!(selection instanceof TextSelection)) return false;
  if (state.doc.textBetween(selection.from, selection.to).trim() === '') {
    return false;
  }
  return selection.$from.parent.type.spec.code !== true;
};

/** What an action may ask of the surface beyond the editor itself. */
export interface FormatContext {
  /** Opens the surface's link field at the selection. */
  openLink: () => void;
}

/** One toolbar button. */
export interface FormatAction {
  id: string;
  label: string;
  icon: IconType;
  /** The chord that does the same, as `mod`, `shift`, `alt` and a key. */
  keys: string[];
  isActive: (editor: Editor) => boolean;
  run: (editor: Editor, context: FormatContext) => void;
}

/** A heading toggle for one level. */
const heading = (level: 1 | 2 | 3, icon: IconType): FormatAction => ({
  id: `heading${String(level)}`,
  label: `Heading ${String(level)}`,
  icon,
  keys: ['mod', 'alt', String(level)],
  isActive: (editor) => editor.isActive('heading', { level }),
  run: (editor) => {
    editor.chain().focus().toggleHeading({ level }).run();
  },
});

/** The toolbar's buttons, in the groups it separates them into. */
export const FORMAT_GROUPS: FormatAction[][] = [
  [
    {
      id: 'bold',
      label: 'Bold',
      icon: LuBold,
      keys: ['mod', 'b'],
      isActive: (editor) => editor.isActive('bold'),
      run: (editor) => {
        editor.chain().focus().toggleBold().run();
      },
    },
    {
      id: 'italic',
      label: 'Italic',
      icon: LuItalic,
      keys: ['mod', 'i'],
      isActive: (editor) => editor.isActive('italic'),
      run: (editor) => {
        editor.chain().focus().toggleItalic().run();
      },
    },
    {
      id: 'strike',
      label: 'Strikethrough',
      icon: LuStrikethrough,
      keys: ['mod', 'shift', 's'],
      isActive: (editor) => editor.isActive('strike'),
      run: (editor) => {
        editor.chain().focus().toggleStrike().run();
      },
    },
    {
      id: 'code',
      label: 'Inline code',
      icon: LuCode,
      keys: ['mod', 'e'],
      isActive: (editor) => editor.isActive('code'),
      run: (editor) => {
        editor.chain().focus().toggleCode().run();
      },
    },
    {
      id: 'link',
      label: 'Link',
      icon: LuLink,
      keys: ['mod', 'k'],
      isActive: (editor) => editor.isActive('link'),
      run: (_editor, context) => {
        context.openLink();
      },
    },
  ],
  [heading(1, LuHeading1), heading(2, LuHeading2), heading(3, LuHeading3)],
  [
    {
      id: 'bulletList',
      label: 'Bulleted list',
      icon: LuList,
      keys: ['mod', 'shift', '8'],
      isActive: (editor) => editor.isActive('bulletList'),
      run: (editor) => {
        editor.chain().focus().toggleBulletList().run();
      },
    },
    {
      id: 'orderedList',
      label: 'Numbered list',
      icon: LuListOrdered,
      keys: ['mod', 'shift', '9'],
      isActive: (editor) => editor.isActive('orderedList'),
      run: (editor) => {
        editor.chain().focus().toggleOrderedList().run();
      },
    },
    {
      id: 'taskList',
      label: 'Checklist',
      icon: LuListTodo,
      keys: ['mod', 'shift', '7'],
      isActive: (editor) => editor.isActive('taskList'),
      run: (editor) => {
        editor.chain().focus().toggleTaskList().run();
      },
    },
  ],
  [
    {
      id: 'blockquote',
      label: 'Quote',
      icon: LuTextQuote,
      keys: ['mod', 'shift', 'b'],
      isActive: (editor) => editor.isActive('blockquote'),
      run: (editor) => {
        editor.chain().focus().toggleBlockquote().run();
      },
    },
    {
      id: 'codeBlock',
      label: 'Code block',
      icon: LuSquareCode,
      keys: ['mod', 'shift', '\\'],
      isActive: (editor) => editor.isActive('codeBlock'),
      run: (editor) => {
        editor.chain().focus().toggleCodeBlock().run();
      },
    },
  ],
];

/** Every toolbar action, in order. */
export const FORMAT_ACTIONS: FormatAction[] = FORMAT_GROUPS.flat();

/**
 * How a chord reads in a tooltip: modifier symbols run together on Apple
 * platforms, and names joined by plus signs elsewhere.
 */
export const shortcutLabel = (
  keys: string[],
  apple: boolean = isApplePlatform()
): string =>
  keys
    .map((key) => {
      if (key === 'mod') return modKeyLabel(apple);
      if (key === 'shift') return shiftKeyLabel(apple);
      if (key === 'alt') return altKeyLabel(apple);
      return key.length === 1 ? key.toUpperCase() : key;
    })
    .join(apple ? '' : '+');

/** The tooltip of an action: its name, then its keys. */
export const actionTooltip = (
  action: FormatAction,
  apple: boolean = isApplePlatform()
): string => `${action.label}  ${shortcutLabel(action.keys, apple)}`;
