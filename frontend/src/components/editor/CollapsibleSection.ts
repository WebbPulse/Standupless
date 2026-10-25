/**
 * Collapsible sections, Linear's toggle blocks: a one line summary with a
 * disclosure caret, over a body that holds any block content and folds away.
 * Typing `>>> ` at the start of a line or picking the slash command makes one,
 * with the line's text as its summary.
 *
 * The stored form is GitHub's `<details><summary>` block, so the read-mode
 * renderer, GitHub sync and email all see a section rather than markup. The
 * summary is plain text, which is all GitHub shows there. Whether a section
 * is open is the reader's view rather than the document's, so it is never
 * written: sections read from Markdown start closed, and a new one starts
 * open so its body can be filled in.
 *
 * In a summary, Tab nests the section into the one above it and Shift+Tab
 * lifts a nested section out one level, as in Linear.
 */

import type { Editor, JSONContent, MarkdownToken } from '@tiptap/core';
import { Extension, InputRule, Node } from '@tiptap/core';
import type {
  Node as ProseMirrorNode,
  ResolvedPos,
  Schema,
} from '@tiptap/pm/model';
import {
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { collapsibleAt, writeSummary } from '../../lib/markdown';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    collapsibleSection: {
      /** Turns the block at the caret into a section with its text as summary. */
      setCollapsibleSection: () => ReturnType;
      /** Opens or closes the section at a position. */
      toggleCollapsibleSection: (position: number) => ReturnType;
    };
  }
}

/** Shown in an empty summary. */
export const SUMMARY_PLACEHOLDER = 'Section title';

/** The node names a section is built from. */
const SECTION = 'collapsibleSection';
const SUMMARY = 'collapsibleSummary';
const BODY = 'collapsibleBody';

/** Whether a section is open, reading a missing attribute as open. */
const isOpen = (node: ProseMirrorNode): boolean => node.attrs['open'] !== false;

/** A new, open section with a summary and an empty paragraph to write in. */
const newSection = (
  schema: Schema,
  summary: string
): ProseMirrorNode | null => {
  const section = schema.nodes[SECTION];
  const title = schema.nodes[SUMMARY];
  const body = schema.nodes[BODY];
  const paragraph = schema.nodes['paragraph'];
  if (
    section === undefined ||
    title === undefined ||
    body === undefined ||
    paragraph === undefined
  ) {
    return null;
  }
  return section.create({ open: true }, [
    title.create(null, summary === '' ? null : schema.text(summary)),
    body.create(null, paragraph.create()),
  ]);
};

/**
 * Replaces the textblock a position sits in with a new section whose summary
 * is the block's text, and puts the caret at the summary's end. Nothing
 * changes inside code, inside a summary, or where a section cannot stand.
 */
const wrapTextblock = (tr: Transaction, $at: ResolvedPos): boolean => {
  const block = $at.parent;
  if (!block.isTextblock || block.type.spec.code === true) return false;
  if (block.type.name === SUMMARY || $at.depth < 1) return false;
  const holder = $at.node($at.depth - 1);
  const index = $at.index($at.depth - 1);
  const summary = block.textContent.replace(/\s+/g, ' ').trimStart();
  const section = newSection(tr.doc.type.schema, summary);
  if (section === null) return false;
  if (!holder.canReplaceWith(index, index + 1, section.type)) return false;
  const start = $at.before();
  tr.replaceWith(start, $at.after(), section);
  tr.setSelection(TextSelection.create(tr.doc, start + 2 + summary.length));
  return true;
};

/** The section, and where it starts, that a summary or body position is in. */
const sectionAround = (
  $at: ResolvedPos,
  child: string
): { node: ProseMirrorNode; pos: number; depth: number } | null => {
  for (let depth = $at.depth; depth > 0; depth -= 1) {
    if ($at.node(depth).type.name !== child) continue;
    const parent = $at.node(depth - 1);
    if (parent.type.name !== SECTION) return null;
    return { node: parent, pos: $at.before(depth - 1), depth: depth - 1 };
  }
  return null;
};

/** The position at the end of a section's summary text. */
const summaryEnd = (section: ProseMirrorNode, pos: number): number =>
  pos + 2 + (section.firstChild?.content.size ?? 0);

/**
 * Turns the section the caret's summary belongs to back into plain blocks:
 * the summary becomes a paragraph unless it is empty, followed by the body.
 */
const unwrapSection = (
  state: EditorState,
  dispatch?: (tr: Transaction) => void
): boolean => {
  const found = sectionAround(state.selection.$from, SUMMARY);
  if (found === null) return false;
  const { schema } = state;
  const paragraph = schema.nodes['paragraph'];
  if (paragraph === undefined) return false;
  const summary = found.node.firstChild;
  const body = found.node.lastChild;
  const blocks: ProseMirrorNode[] = [];
  if (summary !== null && summary.content.size > 0) {
    blocks.push(paragraph.create(null, summary.content));
  }
  const children: ProseMirrorNode[] = [];
  body?.forEach((child) => {
    children.push(child);
  });
  const [only] = children;
  const bodyIsBlank =
    children.length === 1 &&
    only?.type === paragraph &&
    only.content.size === 0;
  if (!bodyIsBlank || blocks.length === 0) blocks.push(...children);
  if (blocks.length === 0) blocks.push(paragraph.create());
  if (dispatch !== undefined) {
    const tr = state.tr.replaceWith(
      found.pos,
      found.pos + found.node.nodeSize,
      blocks
    );
    tr.setSelection(Selection.near(tr.doc.resolve(found.pos + 1), 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Backspace at the start of a summary, or of a section's first body block. */
const backspace = (editor: Editor): boolean => {
  const { state, view } = editor;
  const { selection } = state;
  if (!selection.empty) return false;
  const { $from } = selection;
  if ($from.parentOffset !== 0) return false;
  if ($from.parent.type.name === SUMMARY) {
    return unwrapSection(state, view.dispatch.bind(view));
  }
  if ($from.depth < 2) return false;
  const body = $from.node($from.depth - 1);
  if (body.type.name !== BODY || $from.index($from.depth - 1) !== 0) {
    return false;
  }
  const found = sectionAround($from, BODY);
  if (found === null) return false;
  const tr = state.tr;
  if ($from.parent.content.size === 0 && body.childCount > 1) {
    tr.delete($from.before(), $from.after());
  }
  tr.setSelection(
    TextSelection.create(tr.doc, summaryEnd(found.node, found.pos))
  );
  view.dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Puts the caret on an empty line right after a section, reusing the empty
 * paragraph already there, such as the one the editor keeps at the end of
 * the document, rather than stacking another.
 */
const lineAfter = (tr: Transaction, after: number): void => {
  const next = tr.doc.nodeAt(after);
  const paragraph = tr.doc.type.schema.nodes['paragraph'];
  if (paragraph === undefined) return;
  if (next?.type !== paragraph || next.content.size > 0) {
    tr.insert(after, paragraph.create());
  }
  tr.setSelection(TextSelection.create(tr.doc, after + 1));
};

/**
 * Enter in a summary moves into the body of an open section, onto its first
 * line when that is empty, and past a closed one. Enter on an empty last line
 * of a body leaves the section.
 */
const enter = (editor: Editor): boolean => {
  const { state, view } = editor;
  const { selection, schema } = state;
  const paragraph = schema.nodes['paragraph'];
  if (!selection.empty || paragraph === undefined) return false;
  const { $from } = selection;
  if ($from.parent.type.name === SUMMARY) {
    const found = sectionAround($from, SUMMARY);
    if (found === null) return false;
    const tr = state.tr;
    if (isOpen(found.node)) {
      const bodyStart =
        found.pos + 1 + (found.node.firstChild?.nodeSize ?? 0) + 1;
      const first = found.node.lastChild?.firstChild;
      if (
        first === null ||
        first === undefined ||
        first.type !== paragraph ||
        first.content.size > 0
      ) {
        tr.insert(bodyStart, paragraph.create());
      }
      tr.setSelection(TextSelection.create(tr.doc, bodyStart + 1));
    } else {
      lineAfter(tr, found.pos + found.node.nodeSize);
    }
    view.dispatch(tr.scrollIntoView());
    return true;
  }
  if ($from.parent.type !== paragraph || $from.parent.content.size > 0) {
    return false;
  }
  if ($from.depth < 2) return false;
  const body = $from.node($from.depth - 1);
  const index = $from.index($from.depth - 1);
  if (
    body.type.name !== BODY ||
    body.childCount < 2 ||
    index !== body.childCount - 1
  ) {
    return false;
  }
  const found = sectionAround($from, BODY);
  if (found === null) return false;
  const tr = state.tr.delete($from.before(), $from.after());
  lineAfter(tr, tr.mapping.map(found.pos + found.node.nodeSize));
  view.dispatch(tr.scrollIntoView());
  return true;
};

/** Whether a body holds nothing but one empty paragraph. */
const isBlankBody = (body: ProseMirrorNode): boolean =>
  body.childCount === 1 &&
  body.firstChild?.type.name === 'paragraph' &&
  body.firstChild.content.size === 0;

/**
 * Tab in a summary nests the section into the end of the section directly
 * above it, opening that one so the caret stays visible, and replacing its
 * body when that is a single empty line. Where there is nothing to nest into,
 * the key is held so focus stays in the editor, except inside a list item,
 * where the list's own indent takes it.
 */
const indent = (editor: Editor): boolean => {
  const { state, view } = editor;
  const { $from } = state.selection;
  if ($from.parent.type.name !== SUMMARY) return false;
  const found = sectionAround($from, SUMMARY);
  if (found === null) return false;
  const holder = $from.node(found.depth - 1);
  const index = $from.index(found.depth - 1);
  const previous = index > 0 ? holder.child(index - 1) : null;
  if (previous === null || previous.type.name !== SECTION) {
    return holder.type.name === 'doc' || holder.type.name === BODY;
  }
  const previousPos = found.pos - previous.nodeSize;
  const body = previous.lastChild;
  if (body === null) return false;
  const offset = $from.pos - found.pos;
  const bodyEnd = previousPos + previous.nodeSize - 2;
  const tr = state.tr.delete(found.pos, found.pos + found.node.nodeSize);
  if (!isOpen(previous)) {
    tr.setNodeMarkup(previousPos, undefined, { ...previous.attrs, open: true });
  }
  let at = bodyEnd;
  if (isBlankBody(body)) {
    at = bodyEnd - body.content.size;
    tr.replaceWith(at, bodyEnd, found.node);
  } else {
    tr.insert(at, found.node);
  }
  tr.setSelection(TextSelection.create(tr.doc, at + offset));
  view.dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Shift+Tab in a summary lifts a nested section, with its contents, to just
 * after the section it sits in. A section at the top level stays put and the
 * key is held so focus stays in the editor; inside a list item the list's own
 * outdent takes it.
 */
const outdent = (editor: Editor): boolean => {
  const { state, view } = editor;
  const { $from } = state.selection;
  if ($from.parent.type.name !== SUMMARY) return false;
  const found = sectionAround($from, SUMMARY);
  if (found === null || found.depth < 1) return false;
  const holder = $from.node(found.depth - 1);
  if (holder.type.name === 'doc') return true;
  if (holder.type.name !== BODY || found.depth < 2) return false;
  const outer = $from.node(found.depth - 2);
  if (outer.type.name !== SECTION) return false;
  const outerEnd = $from.before(found.depth - 2) + outer.nodeSize;
  const paragraph = state.schema.nodes['paragraph'];
  if (paragraph === undefined) return false;
  const offset = $from.pos - found.pos;
  const end = found.pos + found.node.nodeSize;
  const tr = state.tr;
  if (holder.childCount === 1) {
    tr.replaceWith(found.pos, end, paragraph.create());
  } else {
    tr.delete(found.pos, end);
  }
  const at = tr.mapping.map(outerEnd);
  tr.insert(at, found.node);
  tr.setSelection(TextSelection.create(tr.doc, at + offset));
  view.dispatch(tr.scrollIntoView());
  return true;
};

/** The outermost closed section whose hidden body holds a position. */
const hiddenSectionAt = (
  $at: ResolvedPos
): { node: ProseMirrorNode; pos: number } | null => {
  for (let depth = 1; depth <= $at.depth; depth += 1) {
    const node = $at.node(depth);
    if (node.type.name !== BODY) continue;
    const section = $at.node(depth - 1);
    if (section.type.name === SECTION && !isOpen(section)) {
      return { node: section, pos: $at.before(depth - 1) };
    }
  }
  return null;
};

/**
 * Keeps the caret out of a closed section's body. Moving forward into one
 * skips past the section, and moving back into one lands at the end of its
 * summary, so arrow keys step over a folded body as if it were not there.
 */
const visibleSelection = (
  oldState: EditorState,
  newState: EditorState
): Transaction | null => {
  const { selection } = newState;
  if (!selection.empty) return null;
  const hidden = hiddenSectionAt(selection.$from);
  if (hidden === null) return null;
  const forward = selection.from > oldState.selection.from;
  const end = summaryEnd(hidden.node, hidden.pos);
  let target: Selection = TextSelection.create(newState.doc, end);
  if (forward) {
    const after = hidden.pos + hidden.node.nodeSize;
    const next = Selection.findFrom(newState.doc.resolve(after), 1, true);
    if (next !== null && hiddenSectionAt(next.$from) === null) target = next;
  }
  return newState.tr.setSelection(target);
};

/** Marks each empty summary so its placeholder shows. */
const emptySummaries = (doc: ProseMirrorNode): DecorationSet => {
  const found: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== SUMMARY) return true;
    if (node.content.size === 0) {
      found.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: 'is-empty',
          'data-placeholder': SUMMARY_PLACEHOLDER,
        })
      );
    }
    return false;
  });
  return DecorationSet.create(doc, found);
};

/** The marked token a section reads from. */
interface SectionToken extends MarkdownToken {
  summary: string;
  tokens: MarkdownToken[];
}

/** The section node: summary and body, the caret, and the stored form. */
export const CollapsibleSection = Node.create({
  name: SECTION,
  group: 'block',
  content: `${SUMMARY} ${BODY}`,
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      open: {
        default: true,
        parseHTML: (element) => element.getAttribute('data-open') !== 'false',
        renderHTML: (attributes) => ({
          'data-open': attributes['open'] === false ? 'false' : 'true',
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: `div[data-type="${SECTION}"]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      { ...HTMLAttributes, 'data-type': SECTION, class: 'rich-collapsible' },
      ['div', { class: 'rich-collapsible-content' }, 0],
    ];
  },

  markdownTokenizer: {
    name: SECTION,
    level: 'block',
    start: (src) => {
      const found = /^ {0,3}<details[\s>]/im.exec(src);
      return found === null ? -1 : found.index;
    },
    tokenize: (src, _tokens, lexer) => {
      const lines = src.split('\n');
      const section = collapsibleAt(lines, 0);
      if (section === null) return undefined;
      const consumed = lines.slice(0, section.end).join('\n');
      const raw =
        src.length > consumed.length && src[consumed.length] === '\n'
          ? `${consumed}\n`
          : consumed;
      const tokens = section.body === '' ? [] : lexer.blockTokens(section.body);
      const token: SectionToken = {
        type: SECTION,
        raw,
        summary: section.summary,
        tokens,
      };
      return token;
    },
  },

  parseMarkdown: (token, helpers) => {
    const { summary, tokens } = token as SectionToken;
    const parse = helpers.parseBlockChildren ?? helpers.parseChildren;
    const body = parse(tokens);
    return helpers.createNode(SECTION, { open: false }, [
      helpers.createNode(
        SUMMARY,
        null,
        summary === '' ? [] : [helpers.createTextNode(summary)]
      ),
      helpers.createNode(
        BODY,
        null,
        body.length === 0 ? [helpers.createNode('paragraph')] : body
      ),
    ]);
  },

  renderMarkdown: (node, helpers) => {
    const [summary, body] = node.content ?? [];
    const title = writeSummary(
      (summary?.content ?? [])
        .map((child: JSONContent) => child.text ?? '')
        .join('')
    );
    const inner = helpers.renderChildren(body?.content ?? [], '\n\n').trim();
    const head = `<details>\n<summary>${title}</summary>`;
    return inner === ''
      ? `${head}\n\n</details>`
      : `${head}\n\n${inner}\n\n</details>`;
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = document.createElement('div');
      dom.className = 'rich-collapsible';
      dom.dataset['type'] = SECTION;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'rich-collapsible-toggle';
      toggle.contentEditable = 'false';
      const content = document.createElement('div');
      content.className = 'rich-collapsible-content';
      dom.append(toggle, content);

      const draw = (): void => {
        const open = isOpen(current);
        dom.dataset['open'] = open ? 'true' : 'false';
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.setAttribute(
          'aria-label',
          open ? 'Collapse section' : 'Expand section'
        );
      };
      draw();

      toggle.addEventListener('mousedown', (event) => {
        event.preventDefault();
      });
      toggle.addEventListener('click', (event) => {
        event.preventDefault();
        const pos = getPos();
        if (typeof pos !== 'number') return;
        editor.commands.toggleCollapsibleSection(pos);
      });

      return {
        dom,
        contentDOM: content,
        stopEvent: (event) =>
          event.target instanceof globalThis.Node &&
          toggle.contains(event.target),
        ignoreMutation: (mutation) =>
          mutation.type !== 'selection' &&
          (toggle.contains(mutation.target) ||
            (mutation.type === 'attributes' && mutation.target === dom)),
        update: (updated) => {
          if (updated.type !== current.type) return false;
          current = updated;
          draw();
          return true;
        },
      };
    };
  },

  addCommands() {
    return {
      setCollapsibleSection:
        () =>
        ({ tr }) =>
          wrapTextblock(tr, tr.selection.$from),
      toggleCollapsibleSection:
        (position) =>
        ({ tr, dispatch }) => {
          const section = tr.doc.nodeAt(position);
          if (section?.type.name !== SECTION) return false;
          if (dispatch === undefined) return true;
          const open = !isOpen(section);
          tr.setNodeMarkup(position, undefined, { ...section.attrs, open });
          if (!open) {
            const $head = tr.selection.$head;
            if (hiddenSectionAt($head) !== null) {
              tr.setSelection(
                TextSelection.create(tr.doc, summaryEnd(section, position))
              );
            }
          }
          tr.setMeta('addToHistory', false).setMeta('preventUpdate', true);
          return true;
        },
    };
  },

  addInputRules() {
    return [
      new InputRule({
        find: /^>>>\s$/,
        handler: ({ state, range }) => {
          const { tr } = state;
          tr.delete(range.from, range.to);
          return wrapTextblock(tr, tr.doc.resolve(range.from))
            ? undefined
            : null;
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => backspace(editor),
      Enter: ({ editor }) => enter(editor),
      Tab: ({ editor }) => indent(editor),
      'Shift-Tab': ({ editor }) => outdent(editor),
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('collapsibleSelection'),
        appendTransaction: (transactions, oldState, newState) =>
          transactions.some((transaction) => transaction.selectionSet)
            ? visibleSelection(oldState, newState)
            : null,
      }),
      new Plugin({
        key: new PluginKey('collapsiblePlaceholder'),
        state: {
          init: (_, state) => emptySummaries(state.doc),
          apply: (transaction, held) =>
            transaction.docChanged ? emptySummaries(transaction.doc) : held,
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});

/** A section's one line summary, plain text only. */
export const CollapsibleSummary = Node.create({
  name: SUMMARY,
  content: 'text*',
  marks: '',
  defining: true,
  isolating: true,
  selectable: false,

  parseHTML() {
    return [{ tag: `div[data-type="${SUMMARY}"]` }];
  },

  renderHTML() {
    return [
      'div',
      { 'data-type': SUMMARY, class: 'rich-collapsible-summary' },
      0,
    ];
  },

  renderMarkdown: (node) =>
    writeSummary(
      (node.content ?? [])
        .map((child: JSONContent) => child.text ?? '')
        .join('')
    ),
});

/** A section's body, which holds any block content. */
export const CollapsibleBody = Node.create({
  name: BODY,
  content: 'block+',
  defining: true,
  selectable: false,

  parseHTML() {
    return [{ tag: `div[data-type="${BODY}"]` }];
  },

  renderHTML() {
    return ['div', { 'data-type': BODY, class: 'rich-collapsible-body' }, 0];
  },

  renderMarkdown: (node, helpers) =>
    helpers.renderChildren(node.content ?? [], '\n\n'),
});

/** Every extension a collapsible section needs. */
export const CollapsibleSectionKit = Extension.create({
  name: 'collapsibleSectionKit',
  addExtensions() {
    return [CollapsibleSection, CollapsibleSummary, CollapsibleBody];
  },
});
