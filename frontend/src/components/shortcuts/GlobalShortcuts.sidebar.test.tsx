/**
 * The `[` shortcut collapses and expands the sidebar as in Linear, is listed
 * under Navigation as Toggle sidebar, and leaves a `[` typed into a field
 * alone.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  readSidebarCollapsed,
  resetSidebarLayout,
} from '../../hooks/useSidebarLayout';
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
const renderShortcuts = async (help = false) => {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/w/mine/inbox']}>
      <ShortcutProvider>
        <GlobalShortcuts
          workspace={workspace}
          teams={[]}
          onShowHelp={() => undefined}
        />
        <input aria-label="Title" />
        {help && <ShortcutHelp open onClose={() => undefined} />}
        <BoundKeys />
      </ShortcutProvider>
    </MemoryRouter>
  );
  await keysBound('[');
  return user;
};

beforeEach(() => {
  resetSidebarLayout();
});

describe('[', () => {
  it('collapses the sidebar and expands it again', async () => {
    const user = await renderShortcuts();

    await user.keyboard('[[');
    expect(readSidebarCollapsed()).toBe(true);

    await user.keyboard('[[');
    expect(readSidebarCollapsed()).toBe(false);
  });

  it('does nothing while typing in a field', async () => {
    const user = await renderShortcuts();

    await user.click(screen.getByRole('textbox', { name: 'Title' }));
    await user.keyboard('[[');

    expect(readSidebarCollapsed()).toBe(false);
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('[');
  });

  it('is listed under Navigation as Toggle sidebar', async () => {
    await renderShortcuts(true);

    const navigation = screen.getByRole('region', { name: 'Navigation' });
    expect(within(navigation).getByText('Toggle sidebar')).toBeInTheDocument();
  });
});
