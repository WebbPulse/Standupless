/**
 * Ctrl+Shift+1 to 9 opens the team in that sidebar position, as in Linear,
 * matched on the physical digit key, never with Cmd, and never while typing.
 * The help lists every digit on one row.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BoundKeys from '../../test/BoundKeys';
import { keysBound } from '../../test/shortcuts';
import type { TeamRead, WorkspaceRead } from '../../types/Api';
import GlobalShortcuts from './GlobalShortcuts';
import ShortcutHelp from './ShortcutHelp';
import ShortcutProvider from './ShortcutProvider';

const navigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>(
      'react-router-dom'
    );
  return { ...actual, useNavigate: () => navigate };
});

/** A team the workspace holds. */
const team = (
  id: string,
  keyPrefix: string,
  extra: Partial<TeamRead> = {}
): TeamRead => ({
  id,
  workspace_id: 'ws-1',
  name: keyPrefix,
  key_prefix: keyPrefix,
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  role: 'admin',
  ...extra,
});

/** The teams in the viewer's saved sidebar order, with a sub-team under the first. */
const teams = [
  team('team-1', 'ENG'),
  team('team-2', 'DES'),
  team('team-3', 'API', { parent_team_id: 'team-1' }),
];

/** The workspace the shell is in. */
const workspace = {
  id: 'ws-1',
  slug: 'mine',
  role: 'owner',
} as WorkspaceRead;

/** Renders the global shortcuts beside a text field, with the help when asked. */
const renderShortcuts = async (help = false) => {
  render(
    <MemoryRouter initialEntries={['/w/mine/inbox']}>
      <ShortcutProvider>
        <GlobalShortcuts
          workspace={workspace}
          teams={teams}
          onShowHelp={() => undefined}
        />
        <input aria-label="Title" />
        {help && <ShortcutHelp open onClose={() => undefined} />}
        <BoundKeys />
      </ShortcutProvider>
    </MemoryRouter>
  );
  await keysBound('ctrl+shift+1', 'ctrl+shift+3');
};

/** Presses a modifier chord on a digit key, reporting the shifted glyph. */
const pressDigit = (
  digit: number,
  modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean },
  target: Element = document.body
): void => {
  const glyphs = ')!@#$%^&*(';
  fireEvent.keyDown(target, {
    key: modifiers.shiftKey === true ? (glyphs[digit] ?? '') : String(digit),
    code: `Digit${String(digit)}`,
    ...modifiers,
  });
};

beforeEach(() => {
  navigate.mockReset();
});

describe('Ctrl+Shift+digit', () => {
  it('opens the team at that position in sidebar order', async () => {
    await renderShortcuts();

    pressDigit(1, { ctrlKey: true, shiftKey: true });
    pressDigit(2, { ctrlKey: true, shiftKey: true });
    pressDigit(3, { ctrlKey: true, shiftKey: true });

    expect(navigate.mock.calls).toEqual([
      ['/w/mine/team/ENG'],
      ['/w/mine/team/API'],
      ['/w/mine/team/DES'],
    ]);
  });

  it('does nothing past the last team', async () => {
    await renderShortcuts();

    pressDigit(4, { ctrlKey: true, shiftKey: true });

    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not fire with Cmd, or with Ctrl and Cmd together', async () => {
    await renderShortcuts();

    pressDigit(1, { metaKey: true, shiftKey: true });
    pressDigit(1, { ctrlKey: true, metaKey: true, shiftKey: true });
    pressDigit(1, { ctrlKey: true });

    expect(navigate).not.toHaveBeenCalled();
  });

  it('does nothing while typing in a field', async () => {
    await renderShortcuts();

    pressDigit(
      1,
      { ctrlKey: true, shiftKey: true },
      screen.getByRole('textbox', { name: 'Title' })
    );

    expect(navigate).not.toHaveBeenCalled();
  });

  it('is listed once under Navigation as Open team 1 to 9', async () => {
    await renderShortcuts(true);

    const navigation = screen.getByRole('region', { name: 'Navigation' });
    expect(within(navigation).getAllByText('Open team 1 to 9')).toHaveLength(1);
    expect(within(navigation).getByText('1-9')).toBeInTheDocument();
  });
});
