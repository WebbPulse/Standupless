/**
 * The jump to comment key. Ctrl or Cmd+M scrolls the issue's composer into
 * view and puts the caret in it, it is listed under Issue for the overlay and
 * the palette, it stands down while typing, and a composer that does not ask
 * for it, such as a reply box, binds nothing.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createShortcutRegistry,
  ShortcutRegistryContext,
  type ShortcutRegistry,
} from '../../hooks/useShortcuts';
import CommentComposer from './CommentComposer';

vi.mock('../../api/drafts', () => ({
  listIssueDrafts: () => Promise.resolve([]),
  saveDraft: () => Promise.resolve({}),
  deleteDraft: () => Promise.resolve(),
}));

vi.mock('../../api/discussion', () => ({
  createComment: vi.fn(),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
}));

let registry: ShortcutRegistry;
let scrollIntoView: ReturnType<typeof vi.fn>;

/** Mounts a composer inside a shortcut registry. */
const renderComposer = (jumpShortcut: boolean) => {
  render(
    <ShortcutRegistryContext.Provider value={registry}>
      <input aria-label="Search" />
      <CommentComposer
        workspaceId="ws-1"
        issueId="iss-1"
        people={[]}
        jumpShortcut={jumpShortcut}
      />
    </ShortcutRegistryContext.Provider>
  );
};

/** The composer surface once the lazy editor has arrived. */
const findSurface = async (): Promise<HTMLElement> =>
  screen.findByRole(
    'textbox',
    { name: 'Write a comment' },
    { timeout: 10_000 }
  );

/** Feeds Ctrl+M to the registry from the given target. */
const pressJump = (target: EventTarget = document.body): boolean => {
  const event = new KeyboardEvent('keydown', {
    key: 'm',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, 'target', { value: target });
  let handled = false;
  act(() => {
    handled = registry.handleKey(event);
  });
  return handled;
};

beforeEach(() => {
  registry = createShortcutRegistry();
  scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    value: scrollIntoView,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

describe('the jump to comment key', () => {
  it('scrolls to the composer and focuses it on Ctrl or Cmd+M', async () => {
    renderComposer(true);
    const surface = await findSurface();
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');

    expect(pressJump()).toBe(true);

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    await waitFor(() => {
      expect(focus.mock.contexts).toContain(surface);
    });
  });

  it('is listed under Issue for the overlay and the palette', async () => {
    renderComposer(true);
    await findSurface();

    expect(
      registry
        .list()
        .filter((shortcut) => shortcut.keys === 'mod+m')
        .map((shortcut) => [shortcut.scope, shortcut.group, shortcut.label])
    ).toEqual([['issue', 'Issue', 'Add a comment']]);
  });

  it('stands down while typing in a field', async () => {
    renderComposer(true);
    await findSurface();

    expect(pressJump(screen.getByRole('textbox', { name: 'Search' }))).toBe(
      false
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('binds nothing for a composer that does not ask for it', async () => {
    renderComposer(false);
    await findSurface();

    expect(pressJump()).toBe(false);
    expect(registry.list().some((shortcut) => shortcut.keys === 'mod+m')).toBe(
      false
    );
  });
});
