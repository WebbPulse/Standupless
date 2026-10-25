/**
 * LaTeX equations in the rich editor, as Linear has them: `$x^2$` typed in a
 * line becomes an inline equation, `$$` typed on an empty line opens a block
 * equation, and the slash menu's Equation inserts one. Each draws as its
 * KaTeX rendering. Clicking an equation, or pressing Enter on a selected one,
 * edits its source in place, a block with a live preview under it, and
 * leaving the source draws it again. An equation left empty is removed, and
 * one that does not parse shows its source in the error style.
 *
 * Both nodes are atoms that hold their LaTeX as an attribute and store as
 * `$...$` and a `$$` fence, documented in `lib/math.ts`, so the API, MCP,
 * email and GitHub read the source as typed and the static renderer reads it
 * back as the same equation.
 */

import type { Editor, MarkdownToken } from '@tiptap/core';
import { InputRule, Node } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
} from '@tiptap/pm/state';
import type { NodeView } from '@tiptap/pm/view';
import type { TokenizerExtension } from 'marked';
import {
  cachedMath,
  INLINE_MATH,
  MATH_FENCE,
  MATH_ONE_LINE,
  renderMath,
  writeBlockMath,
  writeInlineMath,
  type MathResult,
} from '../../lib/math';
import '../ui/math.css';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    math: {
      /** Inserts an empty block equation at the selection and opens it. */
      insertBlockMath: () => ReturnType;
      /** Inserts an empty inline equation at the selection and opens it. */
      insertInlineMath: () => ReturnType;
    };
  }
}

/** The node name an inline equation is stored under. */
export const INLINE_MATH_NODE = 'inlineMath';

/** The node name a block equation is stored under. */
export const BLOCK_MATH_NODE = 'blockMath';

/** The event a selected equation is sent to open its source. */
const EDIT_EVENT = 'standupless-math-edit';

/** The marked token an equation reads from. */
interface MathToken extends MarkdownToken {
  latex: string;
}

/**
 * Editors whose next new equation view opens for editing, set by the commands
 * and input rule that create an empty one.
 */
const openNext = new WeakSet<Editor>();

/** The LaTeX attribute of a node, as a string. */
const latexOf = (node: ProseMirrorNode): string => {
  const value: unknown = node.attrs['latex'];
  return typeof value === 'string' ? value : '';
};

let paintSequence = 0;

/**
 * Draws an equation into an element: its source while KaTeX loads, its
 * rendering once ready, or its source in the error style with the reason on
 * hover. A later paint of the same element wins over a render still pending.
 */
const paintMath = (
  target: HTMLElement,
  latex: string,
  display: boolean
): void => {
  paintSequence += 1;
  const token = String(paintSequence);
  target.dataset['paint'] = token;
  const source = display ? latex : writeInlineMath(latex);
  const show = (result: MathResult | null): void => {
    target.removeAttribute('title');
    if (latex.trim() === '') {
      target.dataset['state'] = 'empty';
      target.textContent = display ? 'Empty equation' : '$ $';
      return;
    }
    if (result === null) {
      target.dataset['state'] = 'loading';
      target.textContent = source;
    } else if (result.ok) {
      target.dataset['state'] = 'ready';
      target.innerHTML = result.html;
    } else {
      target.dataset['state'] = 'error';
      target.textContent = source;
      target.title = result.error;
    }
  };
  const kept = cachedMath(latex, display);
  show(kept ?? null);
  if (kept !== undefined || latex.trim() === '') return;
  void renderMath(latex, display).then((result) => {
    if (target.dataset['paint'] === token) show(result);
  });
};

/** Whether a key event finishes editing: Enter inline, Mod+Enter in a block. */
const isFinishKey = (event: KeyboardEvent, display: boolean): boolean =>
  event.key === 'Enter' &&
  (!display || event.metaKey || event.ctrlKey) &&
  !event.isComposing;

/**
 * The node view both equations share. The rendering shows until the
 * equation is clicked or sent the edit event, when an input for its source
 * takes over, and finishing writes the source back to the node.
 */
class MathView implements NodeView {
  readonly dom: HTMLElement;
  private node: ProseMirrorNode;
  private readonly editor: Editor;
  private readonly getPos: () => number | undefined;
  private readonly display: boolean;
  private readonly face: HTMLElement;
  private field: HTMLInputElement | HTMLTextAreaElement | null = null;
  private editing = false;

  /** Builds the view for one equation node. */
  constructor(
    node: ProseMirrorNode,
    editor: Editor,
    getPos: () => number | undefined,
    display: boolean
  ) {
    this.node = node;
    this.editor = editor;
    this.getPos = getPos;
    this.display = display;
    this.dom = document.createElement(display ? 'div' : 'span');
    this.dom.className = display ? 'rich-math rich-math-block' : 'rich-math';
    this.dom.contentEditable = 'false';
    this.dom.dataset['editable'] = String(editor.isEditable);
    this.face = document.createElement(display ? 'div' : 'span');
    this.face.className = display ? 'math-block' : 'math-inline';
    this.dom.append(this.face);
    paintMath(this.face, latexOf(node), display);
    this.dom.addEventListener('click', (event) => {
      if (this.editing || !this.editor.isEditable) return;
      event.preventDefault();
      this.open();
    });
    this.dom.addEventListener(EDIT_EVENT, () => {
      if (!this.editing && this.editor.isEditable) this.open();
    });
    if (openNext.has(editor) && editor.isEditable) {
      openNext.delete(editor);
      queueMicrotask(() => {
        if (this.dom.isConnected) this.open();
      });
    }
  }

  /** Follows a changed node, redrawing unless its source is being edited. */
  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    const changed = latexOf(node) !== latexOf(this.node);
    this.node = node;
    if (changed && !this.editing) {
      paintMath(this.face, latexOf(node), this.display);
    }
    return true;
  }

  /** Marks the equation selected. */
  selectNode(): void {
    this.dom.classList.add('ProseMirror-selectednode');
  }

  /** Clears the selected mark. */
  deselectNode(): void {
    this.dom.classList.remove('ProseMirror-selectednode');
  }

  /** Keeps the editor out of every event inside the source input. */
  stopEvent(event: Event): boolean {
    return (
      this.field !== null &&
      event.target instanceof globalThis.Node &&
      this.dom.contains(event.target) &&
      event.target !== this.dom
    );
  }

  /** The view draws itself, so no mutation inside it is the document's. */
  ignoreMutation(): boolean {
    return true;
  }

  /** Drops any edit in progress, since the node it would write to is gone. */
  destroy(): void {
    this.editing = false;
    this.field = null;
  }

  /** Swaps the rendering for an input holding the source. */
  private open(): void {
    if (this.editing) return;
    this.editing = true;
    const latex = latexOf(this.node);
    if (this.display) {
      const editor = document.createElement('div');
      editor.className = 'rich-math-block-editor';
      const area = document.createElement('textarea');
      area.value = latex;
      area.rows = Math.max(2, latex.split('\n').length);
      area.spellcheck = false;
      area.setAttribute('aria-label', 'Equation source');
      area.placeholder = 'E = mc^2';
      const preview = document.createElement('div');
      preview.className = 'math-block';
      paintMath(preview, latex, true);
      const hint = document.createElement('span');
      hint.className = 'rich-math-hint';
      hint.textContent = 'Ctrl or Cmd + Enter to finish, Escape to cancel';
      editor.append(area, preview, hint);
      area.addEventListener('input', () => {
        paintMath(preview, area.value, true);
      });
      this.field = area;
      this.dom.replaceChildren(editor);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'rich-math-input';
      input.value = latex;
      input.spellcheck = false;
      input.setAttribute('aria-label', 'Equation source');
      input.placeholder = 'x^2';
      input.size = Math.max(4, latex.length + 1);
      input.addEventListener('input', () => {
        input.size = Math.max(4, input.value.length + 1);
      });
      this.field = input;
      this.dom.replaceChildren(input);
    }
    const field = this.field;
    const host: HTMLElement = field;
    host.addEventListener('keydown', (event) => {
      if (isFinishKey(event, this.display)) {
        event.preventDefault();
        this.close(field.value, true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.close(latex, true);
      }
    });
    host.addEventListener('blur', () => {
      this.close(field.value, false);
    });
    field.focus();
    if (field instanceof HTMLInputElement) {
      field.setSelectionRange(field.value.length, field.value.length);
    }
  }

  /**
   * Leaves the source: writes it to the node, removes an equation left
   * empty, draws it again and, when finished from the keyboard, puts the
   * caret just after it.
   */
  private close(value: string, fromKeyboard: boolean): void {
    if (!this.editing || this.editor.isDestroyed) return;
    this.editing = false;
    this.field = null;
    this.dom.replaceChildren(this.face);
    const latex = this.display ? value.replace(/^\n+|\s+$/g, '') : value.trim();
    paintMath(this.face, latex, this.display);
    const position = this.getPos();
    if (position === undefined) return;
    const { state, view } = this.editor;
    const node = state.doc.nodeAt(position);
    if (node === null || node.type !== this.node.type) return;
    const tr = state.tr;
    if (latex.trim() === '') {
      tr.delete(position, position + node.nodeSize);
      if (fromKeyboard) {
        tr.setSelection(Selection.near(tr.doc.resolve(position)));
      }
    } else {
      if (latex !== latexOf(node)) {
        tr.setNodeMarkup(position, undefined, { ...node.attrs, latex });
      }
      if (fromKeyboard) {
        const after = tr.doc.resolve(position + node.nodeSize);
        tr.setSelection(
          after.parent.inlineContent
            ? TextSelection.create(tr.doc, after.pos)
            : Selection.near(after)
        );
      }
    }
    if (tr.docChanged || fromKeyboard) view.dispatch(tr);
    if (fromKeyboard) view.focus();
  }
}

/**
 * Opens the selected equation when Enter is pressed on it, so an equation
 * reached from the keyboard edits as one that was clicked.
 */
const editSelectedMath = new Plugin({
  key: new PluginKey('mathEditSelected'),
  props: {
    handleKeyDown(view, event) {
      if (event.key !== 'Enter' || !view.editable) return false;
      const { selection } = view.state;
      if (!(selection instanceof NodeSelection)) return false;
      const name = selection.node.type.name;
      if (name !== INLINE_MATH_NODE && name !== BLOCK_MATH_NODE) return false;
      const dom = view.nodeDOM(selection.from);
      if (!(dom instanceof HTMLElement)) return false;
      event.preventDefault();
      dom.dispatchEvent(new CustomEvent(EDIT_EVENT));
      return true;
    },
  },
});

/** The block equation at the start of some Markdown, if one opens there. */
const blockMathAt = (src: string): MathToken | undefined => {
  const lines = src.split('\n');
  const first = lines[0] ?? '';
  const one = MATH_ONE_LINE.exec(first);
  const tail = (end: number): string => (end < lines.length ? '\n' : '');
  if (one !== null) {
    return {
      type: BLOCK_MATH_NODE,
      raw: `${first}${tail(1)}`,
      latex: (one[1] ?? '').trim(),
      tokens: [],
    };
  }
  if (!MATH_FENCE.test(first)) return undefined;
  for (let index = 1; index < lines.length; index += 1) {
    if (MATH_FENCE.test(lines[index] ?? '')) {
      return {
        type: BLOCK_MATH_NODE,
        raw: `${lines.slice(0, index + 1).join('\n')}${tail(index + 1)}`,
        latex: lines
          .slice(1, index)
          .join('\n')
          .replace(/^\n+|\s+$/g, ''),
        tokens: [],
      };
    }
  }
  return undefined;
};

/**
 * The marked inline tokenizer for a stored inline equation. It starts only at
 * a `$` no backslash escapes, so `\$` stays a literal dollar sign.
 */
export const inlineMathTokenizer: TokenizerExtension = {
  name: INLINE_MATH_NODE,
  level: 'inline',
  start(src) {
    const index = src.search(/(?<!\\)\$/);
    return index === -1 ? undefined : index;
  },
  tokenizer(src) {
    const found = INLINE_MATH.exec(src);
    if (found === null) return undefined;
    return {
      type: INLINE_MATH_NODE,
      raw: found[0],
      latex: found[1] ?? '',
      tokens: [],
    };
  },
};

/** The inline equation node. */
export const InlineMath = Node.create({
  name: INLINE_MATH_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-latex') ?? '',
        renderHTML: (attributes: Record<string, unknown>) => ({
          'data-latex':
            typeof attributes['latex'] === 'string' ? attributes['latex'] : '',
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-inline-math]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      { ...HTMLAttributes, 'data-inline-math': '' },
      writeInlineMath(latexOf(node)),
    ];
  },

  renderText: ({ node }) => writeInlineMath(latexOf(node)),

  parseMarkdown: (token, helpers) =>
    helpers.createNode(INLINE_MATH_NODE, {
      latex: (token as MathToken).latex,
    }),

  renderMarkdown: (node) => {
    const latex = node.attrs?.['latex'];
    return typeof latex === 'string' && latex.trim() !== ''
      ? writeInlineMath(latex)
      : '';
  },

  addNodeView() {
    return ({ node, editor, getPos }) =>
      new MathView(node, editor, getPos, false);
  },

  addInputRules() {
    const type = this.type;
    return [
      new InputRule({
        find: /(?<![\\$])\$(?![\s$])((?:\\[\s\S]|[^\\$\n])*?[^\\\s$])\$$/,
        handler: ({ state, range, match }) => {
          const latex = match[1];
          if (latex === undefined) return null;
          state.tr.replaceWith(range.from, range.to, type.create({ latex }));
          return undefined;
        },
      }),
    ];
  },

  addCommands() {
    return {
      insertInlineMath:
        () =>
        ({ commands, editor }) => {
          openNext.add(editor);
          const done = commands.insertContent({
            type: INLINE_MATH_NODE,
            attrs: { latex: '' },
          });
          if (!done) openNext.delete(editor);
          return done;
        },
    };
  },

  addProseMirrorPlugins() {
    return [editSelectedMath];
  },
});

/** The block equation node. */
export const BlockMath = Node.create({
  name: BLOCK_MATH_NODE,
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-latex') ?? '',
        renderHTML: (attributes: Record<string, unknown>) => ({
          'data-latex':
            typeof attributes['latex'] === 'string' ? attributes['latex'] : '',
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-block-math]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      { ...HTMLAttributes, 'data-block-math': '' },
      writeBlockMath(latexOf(node)),
    ];
  },

  renderText: ({ node }) => writeBlockMath(latexOf(node)),

  markdownTokenizer: {
    name: BLOCK_MATH_NODE,
    level: 'block',
    start: (src) => {
      const found = /^ {0,3}\$\$/m.exec(src);
      return found === null ? -1 : found.index;
    },
    tokenize: (src) => blockMathAt(src),
  },

  parseMarkdown: (token, helpers) =>
    helpers.createNode(BLOCK_MATH_NODE, {
      latex: (token as MathToken).latex,
    }),

  renderMarkdown: (node) => {
    const latex = node.attrs?.['latex'];
    return writeBlockMath(typeof latex === 'string' ? latex : '');
  },

  addNodeView() {
    return ({ node, editor, getPos }) =>
      new MathView(node, editor, getPos, true);
  },

  addInputRules() {
    const type = this.type;
    const editor = this.editor;
    return [
      new InputRule({
        find: /^\$\$$/,
        handler: ({ state, range }) => {
          const $start = state.doc.resolve(range.from);
          const parent = $start.parent;
          if (parent.type.name !== 'paragraph') return null;
          if ($start.end() !== range.to) return null;
          const index = $start.index(-1);
          if (!$start.node(-1).canReplaceWith(index, index + 1, type)) {
            return null;
          }
          openNext.add(editor);
          state.tr.replaceWith(
            $start.before(),
            $start.after(),
            type.create({ latex: '' })
          );
          return undefined;
        },
      }),
    ];
  },

  addCommands() {
    return {
      insertBlockMath:
        () =>
        ({ commands, editor }) => {
          openNext.add(editor);
          const done = commands.insertContent({
            type: BLOCK_MATH_NODE,
            attrs: { latex: '' },
          });
          if (!done) openNext.delete(editor);
          return done;
        },
    };
  },
});
