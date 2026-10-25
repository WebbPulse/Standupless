/**
 * The insert menu a `/` opens. Typing a slash at the start of a line or after
 * a space lists the blocks the document can hold, the list narrows as the
 * person keeps typing, and a pick replaces the typed `/query` with the block.
 * Each command writes a node the Markdown dialect already stores, so the menu
 * is a way in to existing formatting rather than a new kind of text.
 *
 * Commands are plain data, so the menu draws whatever is listed here and a
 * new block is one more entry.
 */

import type { Editor, Range } from '@tiptap/core';
import type { IconType } from 'react-icons';
import {
  LuAtSign,
  LuHeading1,
  LuHeading2,
  LuHeading3,
  LuImage,
  LuList,
  LuListCollapse,
  LuListOrdered,
  LuListTodo,
  LuMinus,
  LuSquareCode,
  LuTable,
  LuTextQuote,
  LuWorkflow,
} from 'react-icons/lu';
import { MERMAID_LANGUAGE, MERMAID_STARTER } from '../../lib/mermaid';

/** What a surface can do that some commands depend on. */
export interface SlashContext {
  /** Opens a file picker whose picks upload at the caret. Unset hides uploads. */
  pickFiles?: () => void;
  /** True when the surface suggests people for an @mention. */
  mentions?: boolean;
}

/** One row of the insert menu. */
export interface SlashCommand {
  id: string;
  label: string;
  icon: IconType;
  /** Other words the filter matches, such as `h1` or `todo`. */
  keywords: string[];
  /** The Markdown that types the same block, shown at the row's end. */
  hint?: string;
  /** Whether the surface can run it. Unset means always. */
  available?: (context: SlashContext) => boolean;
  run: (editor: Editor, range: Range, context: SlashContext) => void;
}

/** The slash being typed, where it starts in the block, and what follows it. */
export interface SlashQuery {
  start: number;
  query: string;
}

/** The longest query the menu stays open for. */
const MAX_QUERY = 24;

/** A heading of one level. */
const heading = (level: 1 | 2 | 3, icon: IconType): SlashCommand => ({
  id: `heading${String(level)}`,
  label: `Heading ${String(level)}`,
  icon,
  keywords: [`h${String(level)}`, 'title', 'heading'],
  hint: '#'.repeat(level),
  run: (editor, range) => {
    editor.chain().focus().deleteRange(range).setHeading({ level }).run();
  },
});

/** Every command, in the order the menu lists them. */
export const SLASH_COMMANDS: SlashCommand[] = [
  heading(1, LuHeading1),
  heading(2, LuHeading2),
  heading(3, LuHeading3),
  {
    id: 'bulletList',
    label: 'Bulleted list',
    icon: LuList,
    keywords: ['bullet', 'unordered', 'ul', 'list'],
    hint: '-',
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).toggleBulletList().run();
    },
  },
  {
    id: 'orderedList',
    label: 'Numbered list',
    icon: LuListOrdered,
    keywords: ['ordered', 'ol', 'list', 'number'],
    hint: '1.',
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).toggleOrderedList().run();
    },
  },
  {
    id: 'taskList',
    label: 'Checklist',
    icon: LuListTodo,
    keywords: ['todo', 'task', 'checkbox', 'list'],
    hint: '[ ]',
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).toggleTaskList().run();
    },
  },
  {
    id: 'blockquote',
    label: 'Quote',
    icon: LuTextQuote,
    keywords: ['blockquote', 'citation'],
    hint: '>',
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).setBlockquote().run();
    },
  },
  {
    id: 'codeBlock',
    label: 'Code block',
    icon: LuSquareCode,
    keywords: ['code', 'snippet', 'pre', 'fence'],
    hint: '```',
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).setCodeBlock().run();
    },
  },
  {
    id: 'diagram',
    label: 'Mermaid diagram',
    icon: LuWorkflow,
    keywords: ['diagram', 'mermaid', 'flowchart', 'chart', 'sequence', 'graph'],
    run: (editor, range) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({
          type: 'codeBlock',
          attrs: { language: MERMAID_LANGUAGE },
          content: [{ type: 'text', text: MERMAID_STARTER }],
        })
        .run();
    },
  },
  {
    id: 'collapsible',
    label: 'Collapsible section',
    icon: LuListCollapse,
    keywords: ['toggle', 'details', 'collapse', 'fold', 'expand', 'section'],
    hint: '>>>',
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).setCollapsibleSection().run();
    },
  },
  {
    id: 'divider',
    label: 'Divider',
    icon: LuMinus,
    keywords: ['horizontal', 'rule', 'hr', 'separator', 'line'],
    hint: '---',
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).setHorizontalRule().run();
    },
  },
  {
    id: 'table',
    label: 'Table',
    icon: LuTable,
    keywords: ['grid', 'columns', 'rows'],
    run: (editor, range) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run();
    },
  },
  {
    id: 'attachment',
    label: 'Image or attachment',
    icon: LuImage,
    keywords: ['image', 'picture', 'photo', 'file', 'upload', 'video'],
    available: (context) => context.pickFiles !== undefined,
    run: (editor, range, context) => {
      editor.chain().focus().deleteRange(range).run();
      context.pickFiles?.();
    },
  },
  {
    id: 'mention',
    label: 'Mention a person',
    icon: LuAtSign,
    keywords: ['mention', 'person', 'people', 'user', 'at'],
    hint: '@',
    available: (context) => context.mentions === true,
    run: (editor, range) => {
      editor.chain().focus().insertContentAt(range, '@').run();
    },
  },
];

/**
 * The slash the caret is in, or null. The `/` must start the block's text or
 * follow whitespace, so a path or a URL being typed never opens the menu, and
 * the query stops at the first space.
 */
export const slashQuery = (before: string): SlashQuery | null => {
  const match = /(^|\s)\/([^\s/]*)$/.exec(before);
  if (match === null) return null;
  const query = match[2] ?? '';
  if (query.length > MAX_QUERY) return null;
  return { start: before.length - query.length - 1, query };
};

/** How well a command matches a query: lower is better, null is no match. */
const rank = (command: SlashCommand, query: string): number | null => {
  if (query === '') return 0;
  const label = command.label.toLowerCase();
  if (label.startsWith(query)) return 0;
  if (label.split(/\s+/).some((word) => word.startsWith(query))) return 1;
  if (command.keywords.some((word) => word.startsWith(query))) return 2;
  if (label.includes(query)) return 3;
  return null;
};

/**
 * The commands a surface can run that match the typed query, best match
 * first and in menu order within a tier.
 */
export const filterSlashCommands = (
  query: string,
  context: SlashContext,
  commands: SlashCommand[] = SLASH_COMMANDS
): SlashCommand[] => {
  const typed = query.trim().toLowerCase();
  return commands
    .filter((command) => command.available?.(context) ?? true)
    .map((command, index) => ({ command, index, score: rank(command, typed) }))
    .filter(
      (
        entry
      ): entry is { command: SlashCommand; index: number; score: number } =>
        entry.score !== null
    )
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.command);
};
