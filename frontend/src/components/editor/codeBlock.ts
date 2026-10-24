/**
 * The editor's code block: highlighted through lowlight, with a language
 * picker and a copy button sitting on the block. The fence language is the
 * node's `language` attribute, written back exactly as it was read, so a
 * block opened as ```` ```ts ```` stays `ts` unless someone picks another.
 * Without a language the highlighter detects one.
 *
 * Tab and Shift+Tab indent and outdent inside the block rather than moving
 * focus. Pressing Enter three times at the end leaves the block, as does the
 * down arrow anywhere on its last line rather than only at its very end.
 *
 * The highlighter loads on demand the first time a document holds a code
 * block. Until then the block shows as plain text, and once it arrives each
 * block is redrawn in place without touching the document or the undo stack.
 */

import type { Editor } from '@tiptap/core';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Selection } from '@tiptap/pm/state';
import type { NodeView } from '@tiptap/pm/view';
import { copyToClipboard } from '../../hooks/useCopy';
import {
  CODE_LANGUAGES,
  codeLanguage,
  lazyLowlight,
  loadedHighlighter,
  loadHighlighter,
} from '../../lib/highlight';
import '../ui/codeBlock.css';

/** The spaces one press of Tab indents by. */
export const CODE_TAB_SIZE = 2;

/** How long the copy button reads as copied. */
const COPIED_MS = 1500;

/** Whether a document holds at least one code block. */
const hasCodeBlock = (doc: ProseMirrorNode): boolean => {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (node.type.name === 'codeBlock') found = true;
    return !node.isTextblock;
  });
  return found;
};

/**
 * Redraws every code block once the highlighter has arrived, by rewriting
 * each one's markup unchanged. The transaction stays off the undo stack and
 * emits no update, so nothing reads it as an edit.
 */
const rehighlight = (editor: Editor): void => {
  if (editor.isDestroyed) return;
  const { state, view } = editor;
  const tr = state.tr;
  state.doc.descendants((node, position) => {
    if (node.type.name === 'codeBlock') {
      tr.setNodeMarkup(position, undefined, node.attrs);
      return false;
    }
    return !node.isTextblock;
  });
  if (!tr.docChanged) return;
  tr.setMeta('addToHistory', false).setMeta('preventUpdate', true);
  view.dispatch(tr);
};

/** Starts loading the highlighter when a document first needs it. */
const ensureHighlighter = (editor: Editor): void => {
  if (loadedHighlighter() !== null || !hasCodeBlock(editor.state.doc)) return;
  void loadHighlighter().then(() => {
    rehighlight(editor);
  });
};

/** The outline of the copy icon, as Lucide draws it. */
const COPY_ICON: [string, Record<string, string>][] = [
  ['rect', { width: '14', height: '14', x: '8', y: '8', rx: '2', ry: '2' }],
  ['path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }],
];

/** The outline of the check shown once a copy took. */
const CHECK_ICON: [string, Record<string, string>][] = [
  ['path', { d: 'M20 6 9 17l-5-5' }],
];

/** Draws an outline icon from its shapes. */
const icon = (shapes: [string, Record<string, string>][]): SVGSVGElement => {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  const attributes: Record<string, string> = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  };
  for (const [name, value] of Object.entries(attributes)) {
    svg.setAttribute(name, value);
  }
  for (const [tag, shapeAttributes] of shapes) {
    const shape = document.createElementNS(namespace, tag);
    for (const [name, value] of Object.entries(shapeAttributes)) {
      shape.setAttribute(name, value);
    }
    svg.append(shape);
  }
  return svg;
};

/** Builds an element with a class and optional attributes. */
const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  attributes: Record<string, string> = {}
): HTMLElementTagNameMap[K] => {
  const created = document.createElement(tag);
  created.className = className;
  for (const [name, value] of Object.entries(attributes)) {
    created.setAttribute(name, value);
  }
  return created;
};

/**
 * The block as drawn: the code itself, and a bar holding the language picker
 * while editing, its label while reading, and the copy button.
 */
class CodeBlockView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private node: ProseMirrorNode;
  private readonly editor: Editor;
  private readonly getPos: () => number | undefined;
  private readonly bar: HTMLElement;
  private readonly picker: HTMLSelectElement;
  private readonly label: HTMLElement;
  private readonly copyButton: HTMLButtonElement;
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;

  /** Draws the block for a node. */
  constructor(
    node: ProseMirrorNode,
    editor: Editor,
    getPos: () => number | undefined
  ) {
    this.node = node;
    this.editor = editor;
    this.getPos = getPos;
    this.dom = element('div', 'rich-code-block code-block');
    this.bar = element('div', 'rich-code-bar', { contenteditable: 'false' });
    this.label = element('span', 'rich-code-label');
    this.picker = element('select', 'rich-code-language', {
      'aria-label': 'Code language',
    });
    this.copyButton = element('button', 'rich-code-copy code-block-copy', {
      type: 'button',
    });
    this.showCopied(false);
    const pre = element('pre', '');
    this.contentDOM = element('code', 'code-highlight');
    pre.append(this.contentDOM);
    this.bar.append(this.label, this.picker, this.copyButton);
    this.dom.append(pre, this.bar);
    this.picker.addEventListener('change', () => {
      this.choose(this.picker.value);
    });
    this.copyButton.addEventListener('click', () => {
      this.copy();
    });
    this.sync();
  }

  /** The fence language the node carries, or the empty string. */
  private get language(): string {
    const language = (this.node.attrs as { language?: unknown }).language;
    return typeof language === 'string' ? language : '';
  }

  /** Brings the picker, the label and the code's class in line with the node. */
  private sync(): void {
    const language = this.language;
    const entry = codeLanguage(language);
    const value = entry?.id ?? language;
    const options: [string, string][] = [
      ['', 'Auto detect'],
      ...CODE_LANGUAGES.map((item): [string, string] => [item.id, item.label]),
    ];
    if (value !== '' && entry === undefined) options.push([value, value]);
    this.picker.replaceChildren(
      ...options.map(([id, text]) => {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = text;
        return option;
      })
    );
    this.picker.value = value;
    this.label.textContent = entry?.label ?? language;
    this.label.hidden = language === '';
    this.contentDOM.className =
      language === ''
        ? 'code-highlight'
        : `code-highlight language-${language}`;
  }

  /** Sets the block's language from the picker, or clears it for detection. */
  private choose(value: string): void {
    const position = this.getPos();
    if (position === undefined || !this.editor.isEditable) {
      this.sync();
      return;
    }
    const language = value === '' ? null : value;
    if (language === (this.language === '' ? null : this.language)) return;
    this.editor.view.dispatch(
      this.editor.state.tr.setNodeMarkup(position, undefined, {
        ...this.node.attrs,
        language,
      })
    );
  }

  /** Copies the block's text and confirms it on the button for a moment. */
  private copy(): void {
    const text = this.node.textContent;
    void copyToClipboard(text).then((took) => {
      if (!took) return;
      this.showCopied(true);
      clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => {
        this.showCopied(false);
      }, COPIED_MS);
    });
  }

  /** Swaps the copy button between its copy and its copied look. */
  private showCopied(copied: boolean): void {
    const label = copied ? 'Copied' : 'Copy code';
    this.copyButton.setAttribute('aria-label', label);
    this.copyButton.title = label;
    this.copyButton.dataset['copied'] = String(copied);
    this.copyButton.replaceChildren(icon(copied ? CHECK_ICON : COPY_ICON));
  }

  /** Takes a changed node of the same type without redrawing the block. */
  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    const languageChanged =
      node.attrs['language'] !== this.node.attrs['language'];
    this.node = node;
    if (languageChanged) this.sync();
    return true;
  }

  /** Leaves the bar's own events to the bar. */
  stopEvent(event: Event): boolean {
    return event.target instanceof Node && this.bar.contains(event.target);
  }

  /** Ignores changes to the bar, which the editor does not own. */
  ignoreMutation(mutation: { target: Node; type: string }): boolean {
    if (mutation.type === 'selection') return false;
    return !this.contentDOM.contains(mutation.target);
  }

  /** Stops the copy confirmation when the block goes away. */
  destroy(): void {
    clearTimeout(this.copiedTimer);
  }
}

/** The highlighted code block every rich Markdown surface uses. */
export const HighlightedCodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ({ node, editor, getPos }) =>
      new CodeBlockView(node, editor, getPos);
  },
  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      ArrowDown: ({ editor }) => {
        const { doc, selection } = editor.state;
        const { $from, empty } = selection;
        if (!empty || $from.parent.type.name !== this.name) return false;
        const rest = $from.parent.textContent.slice($from.parentOffset);
        if (rest.includes('\n')) return false;
        const after = $from.after();
        if (doc.nodeAt(after) === null) return editor.commands.exitCode();
        return editor.commands.command(({ tr }) => {
          tr.setSelection(Selection.near(doc.resolve(after)));
          return true;
        });
      },
    };
  },
  onCreate() {
    ensureHighlighter(this.editor);
  },
  onTransaction({ transaction }) {
    if (transaction.docChanged) ensureHighlighter(this.editor);
  },
}).configure({
  lowlight: lazyLowlight,
  defaultLanguage: null,
  enableTabIndentation: true,
  tabSize: CODE_TAB_SIZE,
  exitOnTripleEnter: true,
  exitOnArrowDown: true,
});
