/**
 * Holds block moving to Linear's editor: Alt+Shift+ArrowUp and ArrowDown swap
 * the block at the caret, or the selected run, with its neighbour, a list item
 * moves among its own siblings, one undo puts it back, and the result reads
 * back the same through the Markdown codec. The grip menu duplicates, deletes
 * and turns a block into another type, and the grip is switched on only for
 * full-size editable surfaces.
 */

import type { ComponentProps } from 'react';
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BLOCK_HANDLES_ATTRIBUTE,
  BLOCK_MENU_EVENT,
  deleteBlock,
  duplicateBlock,
  movableBlockAt,
  turnBlockInto,
  type BlockMenuRequest,
} from './blockHandle';
import { markdownExtensions } from './markdownExtensions';
import { readMarkdown, writeMarkdown } from './markdownCodec';
import { RichMarkdownEditor } from './RichMarkdownEditor';
import { SLASH_COMMANDS } from './slashCommands';

const editors: Editor[] = [];

afterEach(() => {
  cleanup();
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.innerHTML = '';
});

/** A mounted editor holding a Markdown source. */
const editorWith = (source: string): Editor => {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({ element, extensions: markdownExtensions() });
  editors.push(editor);
  writeMarkdown(editor, source);
  return editor;
};

/** The caret position just inside the first text matching `text`. */
const positionOf = (editor: Editor, text: string): number => {
  let found = -1;
  editor.state.doc.descendants((node, position) => {
    if (found === -1 && node.isText && node.text?.includes(text) === true) {
      found = position + 1;
    }
  });
  return found;
};

/** The position just before the block holding `text`. */
const blockOf = (editor: Editor, text: string): number => {
  const block = movableBlockAt(editor.state.doc, positionOf(editor, text));
  if (block === null) throw new Error(`no block for ${text}`);
  return block.pos;
};

/** Presses Alt+Shift and an arrow in the editor. */
const move = (editor: Editor, direction: 'up' | 'down'): void => {
  act(() => {
    fireEvent.keyDown(editor.view.dom, {
      key: direction === 'up' ? 'ArrowUp' : 'ArrowDown',
      code: direction === 'up' ? 'ArrowUp' : 'ArrowDown',
      keyCode: direction === 'up' ? 38 : 40,
      altKey: true,
      shiftKey: true,
    });
  });
};

/** Writes the editor's Markdown back in and reads it again. */
const roundTrip = (editor: Editor): string => {
  const markdown = readMarkdown(editor);
  writeMarkdown(editor, markdown);
  return readMarkdown(editor);
};

describe('moving blocks from the keyboard', () => {
  it('swaps a paragraph with the one below and back', () => {
    const editor = editorWith('one\n\ntwo\n\nthree');
    editor.commands.setTextSelection(positionOf(editor, 'one'));
    move(editor, 'down');
    expect(readMarkdown(editor)).toBe('two\n\none\n\nthree');
    move(editor, 'down');
    expect(readMarkdown(editor)).toBe('two\n\nthree\n\none');
    move(editor, 'up');
    expect(readMarkdown(editor)).toBe('two\n\none\n\nthree');
  });

  it('keeps the caret in the moved block', () => {
    const editor = editorWith('one\n\ntwo');
    editor.commands.setTextSelection(positionOf(editor, 'two') + 1);
    move(editor, 'up');
    expect(editor.state.selection.$from.parent.textContent).toBe('two');
  });

  it('leaves a block at the edge where it is', () => {
    const editor = editorWith('one\n\ntwo');
    editor.commands.setTextSelection(positionOf(editor, 'one'));
    move(editor, 'up');
    expect(readMarkdown(editor)).toBe('one\n\ntwo');
    editor.commands.setTextSelection(positionOf(editor, 'two'));
    move(editor, 'down');
    expect(readMarkdown(editor)).toBe('one\n\ntwo');
  });

  it('undoes a move in one step', () => {
    const editor = editorWith('one\n\ntwo\n\nthree');
    editor.commands.setTextSelection(positionOf(editor, 'three'));
    move(editor, 'up');
    expect(readMarkdown(editor)).toBe('one\n\nthree\n\ntwo');
    editor.commands.undo();
    expect(readMarkdown(editor)).toBe('one\n\ntwo\n\nthree');
  });

  it('moves every selected block together', () => {
    const editor = editorWith('one\n\ntwo\n\nthree');
    const { doc } = editor.state;
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(
          doc,
          positionOf(editor, 'one'),
          positionOf(editor, 'two') + 1
        )
      )
    );
    move(editor, 'down');
    expect(readMarkdown(editor)).toBe('three\n\none\n\ntwo');
  });

  it('moves a list item among its siblings', () => {
    const editor = editorWith('- a\n- b\n- c');
    editor.commands.setTextSelection(positionOf(editor, 'a'));
    move(editor, 'down');
    expect(readMarkdown(editor)).toBe('- b\n- a\n- c');
  });

  it('moves a nested item inside its own list', () => {
    const editor = editorWith('- a\n  - x\n  - y\n- b');
    editor.commands.setTextSelection(positionOf(editor, 'y'));
    move(editor, 'up');
    expect(readMarkdown(editor)).toBe('- a\n  - y\n  - x\n- b');
    move(editor, 'up');
    expect(readMarkdown(editor)).toBe('- a\n  - y\n  - x\n- b');
  });

  it('moves a checklist item with its state', () => {
    const editor = editorWith('- [x] done\n- [ ] open');
    editor.commands.setTextSelection(positionOf(editor, 'done'));
    move(editor, 'down');
    expect(readMarkdown(editor)).toBe('- [ ] open\n- [x] done');
  });

  it('moves a heading past a code block and survives the codec', () => {
    const editor = editorWith('## Title\n\n```ts\nconst a = 1;\n```\n\nend');
    editor.commands.setTextSelection(positionOf(editor, 'Title'));
    move(editor, 'down');
    const moved = readMarkdown(editor);
    expect(moved).toBe('```ts\nconst a = 1;\n```\n\n## Title\n\nend');
    expect(roundTrip(editor)).toBe(moved);
  });

  it('does nothing in a read-only editor', () => {
    const editor = editorWith('one\n\ntwo');
    editor.setEditable(false);
    editor.commands.setTextSelection(positionOf(editor, 'one'));
    move(editor, 'down');
    expect(readMarkdown(editor)).toBe('one\n\ntwo');
  });
});

describe('the block under a position', () => {
  it('is the innermost list item, or the top-level block', () => {
    const editor = editorWith('para\n\n- a\n  - x');
    const { doc } = editor.state;
    expect(
      movableBlockAt(doc, positionOf(editor, 'para'))?.node.type.name
    ).toBe('paragraph');
    const nested = movableBlockAt(doc, positionOf(editor, 'x'));
    expect(nested?.node.type.name).toBe('listItem');
    expect(nested?.node.textContent).toBe('x');
  });
});

describe('the block menu actions', () => {
  it('duplicates a block right after itself', () => {
    const editor = editorWith('one\n\ntwo');
    duplicateBlock(editor.state, editor.view.dispatch, blockOf(editor, 'one'));
    expect(readMarkdown(editor)).toBe('one\n\none\n\ntwo');
  });

  it('duplicates a list item inside its list', () => {
    const editor = editorWith('- a\n- b');
    duplicateBlock(editor.state, editor.view.dispatch, blockOf(editor, 'a'));
    expect(readMarkdown(editor)).toBe('- a\n- a\n- b');
  });

  it('deletes a block', () => {
    const editor = editorWith('one\n\ntwo');
    deleteBlock(editor.state, editor.view.dispatch, blockOf(editor, 'one'));
    expect(readMarkdown(editor)).toBe('two');
  });

  it('takes the list with its only item', () => {
    const editor = editorWith('before\n\n- only\n\nafter');
    deleteBlock(editor.state, editor.view.dispatch, blockOf(editor, 'only'));
    expect(readMarkdown(editor)).toBe('before\n\nafter');
  });

  it('turns a paragraph into a heading and a list item back into text', () => {
    const editor = editorWith('word\n\n- item');
    const heading = SLASH_COMMANDS.find((each) => each.id === 'heading2');
    if (heading === undefined) throw new Error('no heading command');
    turnBlockInto(editor, blockOf(editor, 'word'), (target, range) => {
      heading.run(target, range, {});
    });
    expect(readMarkdown(editor)).toBe('## word\n\n- item');
    turnBlockInto(editor, blockOf(editor, 'item'), null);
    expect(readMarkdown(editor)).toBe('## word\n\nitem');
  });
});

describe('the grip in a surface', () => {
  /** Renders a surface and answers its wrapper and editor. */
  const renderSurface = (
    props: Partial<ComponentProps<typeof RichMarkdownEditor>> = {}
  ): { wrapper: HTMLElement; editor: Editor } => {
    render(
      <RichMarkdownEditor
        value={'one\n\ntwo'}
        editable
        ariaLabel="Description"
        onCommit={() => true}
        {...props}
      />
    );
    const surface = screen.getByRole('textbox', { name: 'Description' });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    const wrapper = surface.closest('.relative');
    if (!(wrapper instanceof HTMLElement)) throw new Error('no wrapper');
    return { wrapper, editor };
  };

  it('is on for a full-size editable surface', () => {
    const { wrapper } = renderSurface();
    expect(wrapper.hasAttribute(BLOCK_HANDLES_ATTRIBUTE)).toBe(true);
  });

  it.each([
    ['read only', { editable: false }],
    ['compact', { density: 'compact' as const }],
    ['switched off', { blockHandles: false }],
  ])('is off when %s', (_name, props) => {
    const { wrapper } = renderSurface(props);
    expect(wrapper.hasAttribute(BLOCK_HANDLES_ATTRIBUTE)).toBe(false);
  });

  it('opens the block menu and duplicates from it', () => {
    const { editor } = renderSurface();
    const detail: BlockMenuRequest = {
      pos: blockOf(editor, 'one'),
      anchor: new DOMRect(0, 0, 18, 24),
    };
    act(() => {
      editor.view.dom.dispatchEvent(
        new CustomEvent(BLOCK_MENU_EVENT, { detail })
      );
    });
    expect(screen.getByRole('menu', { name: 'Block actions' })).toBeVisible();
    act(() => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    });
    expect(readMarkdown(editor)).toBe('one\n\none\n\ntwo');
    expect(screen.queryByRole('menu', { name: 'Block actions' })).toBeNull();
  });

  it('turns a block into a list from the menu', () => {
    const { editor } = renderSurface();
    const detail: BlockMenuRequest = {
      pos: blockOf(editor, 'two'),
      anchor: new DOMRect(0, 0, 18, 24),
    };
    act(() => {
      editor.view.dom.dispatchEvent(
        new CustomEvent(BLOCK_MENU_EVENT, { detail })
      );
    });
    act(() => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Turn into' }));
    });
    act(() => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Bulleted list' }));
    });
    expect(readMarkdown(editor)).toBe('one\n\n- two');
  });
});
