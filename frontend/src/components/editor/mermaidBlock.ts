/**
 * The diagram face of an editor code block whose fence language is
 * `mermaid`. The block shows its drawn diagram, and a Code and Preview toggle
 * on its bar switches to the source and back. Moving the caret into a
 * previewed diagram, or clicking it, opens the source for editing, and moving
 * the caret out again returns it to the diagram, unless the source was opened
 * from the toggle. The node and its Markdown are untouched: the face is only
 * how the block is drawn.
 */

import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { isMermaidLanguage } from '../../lib/mermaid';
import { MermaidPreview } from './MermaidPreview';
import '../ui/mermaid.css';

/** Which face of a diagram block is showing. */
export type MermaidFace = 'preview' | 'code';

/** The faces in the order the toggle lists them. */
const FACES: [MermaidFace, string][] = [
  ['code', 'Code'],
  ['preview', 'Preview'],
];

/**
 * The toggle and the preview one code block carries. They stay hidden while
 * the block is in any other language, so picking Mermaid in the language
 * picker turns them on in place.
 */
export class MermaidControls {
  readonly toggle: HTMLElement;
  readonly preview: HTMLElement;
  private node: ProseMirrorNode;
  private readonly dom: HTMLElement;
  private readonly editor: Editor;
  private readonly getPos: () => number | undefined;
  private readonly buttons = new Map<MermaidFace, HTMLButtonElement>();
  private face: MermaidFace = 'preview';
  private active = false;
  private opened = false;
  private root: Root | null = null;
  private readonly onSelection = (): void => {
    this.followSelection();
  };

  /** Builds the controls for a block's outer element and node. */
  constructor(
    dom: HTMLElement,
    node: ProseMirrorNode,
    editor: Editor,
    getPos: () => number | undefined
  ) {
    this.dom = dom;
    this.node = node;
    this.editor = editor;
    this.getPos = getPos;
    this.toggle = document.createElement('div');
    this.toggle.className = 'mermaid-toggle';
    this.toggle.setAttribute('role', 'group');
    this.toggle.setAttribute('aria-label', 'Diagram view');
    this.toggle.hidden = true;
    for (const [face, label] of FACES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.dataset['face'] = face;
      button.addEventListener('click', () => {
        this.opened = false;
        this.show(face);
      });
      this.buttons.set(face, button);
      this.toggle.append(button);
    }
    this.preview = document.createElement('div');
    this.preview.className = 'rich-mermaid-preview';
    this.preview.setAttribute('contenteditable', 'false');
    this.editor.on('selectionUpdate', this.onSelection);
    this.update(node);
  }

  /** The face showing, for the view and tests. */
  get current(): MermaidFace | null {
    return this.active ? this.face : null;
  }

  /** Whether an event target belongs to the controls rather than the code. */
  contains(target: Node): boolean {
    return this.toggle.contains(target) || this.preview.contains(target);
  }

  /** Follows a changed node: its language turns the face on or off. */
  update(node: ProseMirrorNode): void {
    this.node = node;
    const active = isMermaidLanguage(
      (node.attrs as { language?: string | null }).language
    );
    if (!active) {
      if (this.active) this.deactivate();
      return;
    }
    if (!this.active) {
      this.active = true;
      this.opened = this.editor.isEditable && this.caretInside();
      this.face = this.opened ? 'code' : 'preview';
    }
    this.draw();
  }

  /** Stops following the editor when the block goes away. */
  destroy(): void {
    this.editor.off('selectionUpdate', this.onSelection);
    this.unmount();
  }

  /** Shows one face and redraws. */
  private show(face: MermaidFace): void {
    this.face = face;
    this.draw();
  }

  /** Whether the editor's selection sits inside this block. */
  private caretInside(): boolean {
    const position = this.getPos();
    if (position === undefined) return false;
    const { from, to } = this.editor.state.selection;
    return from > position && to < position + this.node.nodeSize;
  }

  /** Opens the source while the caret is in the block, and closes it after. */
  private followSelection(): void {
    if (!this.active || !this.editor.isEditable) return;
    const inside = this.caretInside();
    if (inside && this.face === 'preview') {
      this.opened = true;
      this.show('code');
    } else if (!inside && this.opened && this.face === 'code') {
      this.opened = false;
      this.show('preview');
    }
  }

  /** Puts the caret at the end of the source, opening it for editing. */
  private edit(): void {
    const position = this.getPos();
    if (position === undefined || !this.editor.isEditable) return;
    this.opened = true;
    this.show('code');
    const end = position + this.node.nodeSize - 1;
    this.editor.view.dispatch(
      this.editor.state.tr.setSelection(
        TextSelection.create(this.editor.state.doc, end)
      )
    );
    this.editor.view.focus();
  }

  /** Brings the block's face, the toggle and the preview in line. */
  private draw(): void {
    this.dom.dataset['mermaid'] = this.face;
    this.toggle.hidden = false;
    for (const [face, button] of this.buttons) {
      button.setAttribute('aria-pressed', String(face === this.face));
    }
    if (this.face !== 'preview') return;
    this.root ??= createRoot(this.preview);
    const source = this.node.textContent;
    this.root.render(
      this.editor.isEditable
        ? createElement(MermaidPreview, {
            source,
            onActivate: () => {
              this.edit();
            },
          })
        : createElement(MermaidPreview, { source })
    );
  }

  /** Turns the face off when the block leaves Mermaid. */
  private deactivate(): void {
    this.active = false;
    this.opened = false;
    delete this.dom.dataset['mermaid'];
    this.toggle.hidden = true;
    this.unmount();
  }

  /** Unmounts the preview after the current render has finished. */
  private unmount(): void {
    const root = this.root;
    this.root = null;
    if (root !== null) {
      queueMicrotask(() => {
        root.unmount();
      });
    }
  }
}
