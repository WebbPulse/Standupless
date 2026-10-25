/**
 * Alt+Shift+Q logs out as in Linear, matched by the physical key so the
 * glyph Option types on a Mac still counts, is listed under General, and
 * leaves a field being typed into alone.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { LOG_OUT_KEYS } from '../../lib/logOut';
import BoundKeys from '../../test/BoundKeys';
import { keysBound } from '../../test/shortcuts';
import type { WorkspaceRead } from '../../types/Api';
import GlobalShortcuts from './GlobalShortcuts';
import ShortcutHelp from './ShortcutHelp';
import ShortcutProvider from './ShortcutProvider';

/** The workspace the shell is in. */
const workspace = {
  id: 'ws-1',
  slug: 'mine',
  role: 'owner',
} as WorkspaceRead;

/** Renders the global shortcuts beside a text field, with the help when asked. */
const renderShortcuts = async (onLogOut: () => void, help = false) => {
  render(
    <MemoryRouter initialEntries={['/w/mine/inbox']}>
      <ShortcutProvider>
        <GlobalShortcuts
          workspace={workspace}
          teams={[]}
          onShowHelp={() => undefined}
          onLogOut={onLogOut}
        />
        <input aria-label="Title" />
        {help && <ShortcutHelp open onClose={() => undefined} />}
        <BoundKeys />
      </ShortcutProvider>
    </MemoryRouter>
  );
  await keysBound(LOG_OUT_KEYS);
};

/** Presses Alt+Shift+Q on the target, reporting the given glyph as the key. */
const pressLogOut = (target: Element | Document, key: string): void => {
  fireEvent.keyDown(target, {
    key,
    code: 'KeyQ',
    altKey: true,
    shiftKey: true,
  });
};

describe('Alt+Shift+Q', () => {
  it('logs out', async () => {
    const onLogOut = vi.fn();
    await renderShortcuts(onLogOut);

    pressLogOut(document.body, 'Q');

    expect(onLogOut).toHaveBeenCalledTimes(1);
  });

  it('logs out when Option on a Mac reports another glyph', async () => {
    const onLogOut = vi.fn();
    await renderShortcuts(onLogOut);

    pressLogOut(document.body, 'Œ');

    expect(onLogOut).toHaveBeenCalledTimes(1);
  });

  it('does nothing without Alt', async () => {
    const onLogOut = vi.fn();
    await renderShortcuts(onLogOut);

    fireEvent.keyDown(document.body, {
      key: 'Q',
      code: 'KeyQ',
      shiftKey: true,
    });

    expect(onLogOut).not.toHaveBeenCalled();
  });

  it('does nothing while typing in a field', async () => {
    const onLogOut = vi.fn();
    await renderShortcuts(onLogOut);

    pressLogOut(screen.getByRole('textbox', { name: 'Title' }), 'Q');

    expect(onLogOut).not.toHaveBeenCalled();
  });

  it('is listed under General as Log out', async () => {
    await renderShortcuts(vi.fn(), true);

    const general = screen.getByRole('region', { name: 'General' });
    expect(within(general).getByText('Log out')).toBeInTheDocument();
  });
});
