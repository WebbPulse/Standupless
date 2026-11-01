/**
 * A surface whose first editor is destroyed before its effects run. Tiptap's
 * `useEditor` destroys a new editor one tick after creating it unless its
 * effect has run by then, and rebuilds it in that effect, so a slow commit can
 * run the first pass of effects against a dead editor. The wrapper below
 * forces that order on the first mount, so no timing is involved. The surface
 * must survive it and come up on the replacement editor.
 */

import type { Editor } from '@tiptap/core';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BLOCK_MENU_EVENT, type BlockMenuRequest } from './blockHandle';
import { readMarkdown } from './markdownCodec';
import { RichMarkdownEditor } from './RichMarkdownEditor';

const race = vi.hoisted(() => ({
  armed: false,
  destroyed: null as Editor | null,
}));

vi.mock('@tiptap/react', async () => {
  const actual =
    await vi.importActual<typeof import('@tiptap/react')>('@tiptap/react');
  const { useLayoutEffect } =
    await vi.importActual<typeof import('react')>('react');
  const useEditor = (...args: Parameters<typeof actual.useEditor>): Editor => {
    const editor = actual.useEditor(...args);
    useLayoutEffect(() => {
      if (!race.armed) return;
      race.armed = false;
      race.destroyed = editor;
      editor.destroy();
    }, [editor]);
    return editor;
  };
  return { ...actual, useEditor };
});

/** The Tiptap editor behind a surface. */
const editorOf = (surface: HTMLElement): Editor =>
  (surface as HTMLElement & { editor: Editor }).editor;

/** Mounts a surface whose first editor dies before its effects run. */
const renderThroughRace = (): HTMLElement => {
  race.armed = true;
  render(
    <RichMarkdownEditor
      value="one"
      editable
      ariaLabel="Description"
      onCommit={() => true}
    />
  );
  return screen.getByRole('textbox', { name: 'Description' });
};

describe('an editor destroyed before its effects run', () => {
  beforeEach(() => {
    race.armed = false;
    race.destroyed = null;
  });

  it('comes up on the replacement editor with its text', () => {
    const editor = editorOf(renderThroughRace());

    expect(race.destroyed?.isDestroyed).toBe(true);
    expect(editor).not.toBe(race.destroyed);
    expect(editor.isDestroyed).toBe(false);
    expect(readMarkdown(editor)).toBe('one');
  });

  it('listens for the block menu on the replacement editor', () => {
    const surface = renderThroughRace();
    const detail: BlockMenuRequest = {
      pos: 0,
      anchor: new DOMRect(0, 0, 18, 24),
    };

    act(() => {
      surface.dispatchEvent(new CustomEvent(BLOCK_MENU_EVENT, { detail }));
    });

    expect(screen.getByRole('menu', { name: 'Block actions' })).toBeVisible();
  });
});
