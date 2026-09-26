/**
 * What the command palette answers with: the shortcut that opens it, the
 * keystrokes it refuses to steal, the highlight the arrow keys move, what
 * Enter resolves to for a navigation command, an issue key and a search hit,
 * and the actions it offers: creating an issue or a team, switching team,
 * changing the theme, and the focused issue's shortcuts.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ShortcutProvider from '../shortcuts/ShortcutProvider';
import type { SearchResultRead, TeamRead } from '../../types/Api';
import { useCommandPalette } from '../../hooks/useCommandPalette';
import {
  CreateIssueContext,
  type CreateIssueState,
} from '../../hooks/useCreateIssue';
import {
  CreateTeamContext,
  type CreateTeamState,
} from '../../hooks/useCreateTeam';
import { useShortcut } from '../../hooks/useShortcuts';
import { THEME_STORAGE_KEY } from '../../lib/theme';
import CommandPalette from './CommandPalette';

const search = vi.fn<() => Promise<SearchResultRead[]>>();
const navigate = vi.fn();

vi.mock('../../api/views', () => ({
  search: () => search(),
}));

vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>(
      'react-router-dom'
    );
  return { ...actual, useNavigate: () => navigate };
});

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

/** One team, so the palette offers a "Go to" row for it. */
const engine: TeamRead = {
  id: 'team-1',
  workspace_id: 'ws-1',
  name: 'Engine',
  key_prefix: 'ENG',
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  role: 'admin',
};

/** A second team, so the palette offers switching between them. */
const design: TeamRead = {
  ...engine,
  id: 'team-2',
  name: 'Design',
  key_prefix: 'DES',
};

/** One search hit as the search route answers it. */
const hit: SearchResultRead = {
  issue_id: 'issue-1',
  key: 'ENG-12',
  title: 'Rotate the signing keys',
  team_id: 'team-1',
  status_id: 'status-1',
  assignee_id: null,
  updated_at: '2026-09-17T00:00:00Z',
  score: 1,
};

/** What a harness wraps the palette in beyond the router. */
interface HarnessProps {
  path?: string;
  teams?: TeamRead[];
  createIssue?: CreateIssueState;
  createTeam?: CreateTeamState;
  issueAction?: () => void;
}

/** Registers one focused-issue shortcut, as an issue page would. */
const IssueShortcut: React.FC<{ run: () => void }> = ({ run }) => {
  useShortcut({
    keys: 's',
    label: 'Change status',
    scope: 'issue',
    handler: run,
  });
  return null;
};

/**
 * The palette wired to the hook, with a text field beside it so a test can
 * type somewhere the shortcut must not fire.
 */
const Harness: React.FC<HarnessProps> = ({
  path = '/w/mine',
  teams = [engine],
  createIssue,
  createTeam,
  issueAction,
}) => {
  const { open, closePalette } = useCommandPalette();
  let tree: React.ReactNode = (
    <>
      <input aria-label="Issue title" />
      {issueAction !== undefined && <IssueShortcut run={issueAction} />}
      <CommandPalette
        open={open}
        onClose={closePalette}
        workspace={{ id: 'ws-1', slug: 'mine', role: 'owner' }}
        teams={teams}
      />
    </>
  );
  if (createIssue !== undefined) {
    tree = (
      <CreateIssueContext.Provider value={createIssue}>
        {tree}
      </CreateIssueContext.Provider>
    );
  }
  if (createTeam !== undefined) {
    tree = (
      <CreateTeamContext.Provider value={createTeam}>
        {tree}
      </CreateTeamContext.Provider>
    );
  }
  return (
    <MemoryRouter initialEntries={[path]}>
      <ShortcutProvider>{tree}</ShortcutProvider>
    </MemoryRouter>
  );
};

/** Renders the harness and returns a user-event session bound to it. */
const renderPalette = (props: HarnessProps = {}) => {
  const user = userEvent.setup();
  render(<Harness {...props} />);
  return user;
};

/** A create issue dialog state whose open is a spy. */
const issueDialog = (): CreateIssueState => ({
  open: vi.fn(),
  close: vi.fn(),
  isOpen: false,
  canCreate: true,
  request: null,
});

beforeEach(() => {
  search.mockReset();
  navigate.mockReset();
  search.mockResolvedValue([]);
  globalThis.localStorage.removeItem(THEME_STORAGE_KEY);
});

describe('opening and closing', () => {
  it('opens on Cmd+K', async () => {
    const user = renderPalette();

    await user.keyboard('{Meta>}k{/Meta}');

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('opens on Ctrl+K', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('stays shut while a person is typing in a field', async () => {
    const user = renderPalette();

    await user.click(screen.getByRole('textbox', { name: 'Issue title' }));
    await user.keyboard('k');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('focuses its own input on open', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');

    await waitFor(() => {
      expect(
        screen.getByRole('combobox', { name: 'Type a command or search' })
      ).toHaveFocus();
    });
  });
});

describe('the navigation commands', () => {
  it('offers the workspace places and a row per team', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');

    expect(
      await screen.findByRole('option', { name: /My issues/ })
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Inbox/ })).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: /Go to Engine/ })
    ).toBeInTheDocument();
  });

  it('narrows the places to the typed term', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('road');

    await waitFor(() => {
      expect(
        screen.getByRole('option', { name: /Roadmap/ })
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByRole('option', { name: /Inbox/ })
    ).not.toBeInTheDocument();
  });
});

describe('the highlight', () => {
  it('starts on the first row', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');

    const first = await screen.findByRole('option', {
      name: /Switch to light theme/,
    });
    expect(first).toHaveAttribute('aria-selected', 'true');
  });

  it('moves down and up with the arrow keys', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('option', { name: /Switch to light theme/ });

    await user.keyboard('{ArrowDown}');
    await waitFor(() => {
      expect(
        screen.getByRole('option', { name: /Use system theme/ })
      ).toHaveAttribute('aria-selected', 'true');
    });

    await user.keyboard('{ArrowUp}');
    await waitFor(() => {
      expect(
        screen.getByRole('option', { name: /Switch to light theme/ })
      ).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('wraps to the last row when it moves up off the top', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('option', { name: /Switch to light theme/ });

    await user.keyboard('{ArrowUp}');

    await waitFor(() => {
      expect(
        screen.getByRole('option', { name: /Go to Engine/ })
      ).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('names the highlighted row on the input', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    const first = await screen.findByRole('option', {
      name: /Switch to light theme/,
    });

    expect(
      screen.getByRole('combobox', { name: 'Type a command or search' })
    ).toHaveAttribute('aria-activedescendant', first.id);
  });
});

describe('activating a row', () => {
  it('navigates on Enter and closes', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('my iss');
    await screen.findByRole('option', { name: /My issues/ });

    await user.keyboard('{Enter}');

    expect(navigate).toHaveBeenCalledWith('/w/mine/issues');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('navigates on a click', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');

    await user.click(await screen.findByRole('option', { name: /Roadmap/ }));

    expect(navigate).toHaveBeenCalledWith('/w/mine/roadmap');
  });
});

describe('what a term resolves to', () => {
  it('offers the issue directly for an exact key, without searching', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('eng-12');

    expect(
      await screen.findByRole('option', { name: /Go to ENG-12/ })
    ).toBeInTheDocument();
    expect(search).not.toHaveBeenCalled();

    await user.keyboard('{Enter}');
    expect(navigate).toHaveBeenCalledWith('/w/mine/issues/ENG-12');
  });

  it('renders the hits the search route answers with', async () => {
    search.mockResolvedValue([hit]);
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('signing');

    expect(
      await screen.findByRole('option', { name: /Rotate the signing keys/ })
    ).toBeInTheDocument();
    expect(search).toHaveBeenCalled();
  });

  it('leaves a short word to the index rather than searching it', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('zzz');

    await waitFor(() => {
      expect(screen.getByText(/at least 4 letters/)).toBeInTheDocument();
    });
    expect(search).not.toHaveBeenCalled();
  });
});

describe('the actions', () => {
  it('opens the create issue dialog when the caller may write issues', async () => {
    const dialog = issueDialog();
    const user = renderPalette({ createIssue: dialog });

    await user.keyboard('{Control>}k{/Control}');
    await user.click(
      await screen.findByRole('option', { name: /Create issue/ })
    );

    await waitFor(() => {
      expect(dialog.open).toHaveBeenCalled();
    });
  });

  it('leaves out create issue when the caller may not write issues', async () => {
    const user = renderPalette({
      createIssue: { ...issueDialog(), canCreate: false },
    });

    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('option', { name: /My issues/ });

    expect(
      screen.queryByRole('option', { name: /Create issue/ })
    ).not.toBeInTheDocument();
  });

  it('opens the create team dialog', async () => {
    const open = vi.fn();
    const user = renderPalette({ createTeam: { open, canCreate: true } });

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('create team');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(open).toHaveBeenCalled();
    });
  });

  it('offers every theme but the current one and applies the choice', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    expect(
      screen.queryByRole('option', { name: /Switch to dark theme/ })
    ).not.toBeInTheDocument();

    await user.click(
      await screen.findByRole('option', { name: /Switch to light theme/ })
    );

    await waitFor(() => {
      expect(globalThis.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    });
  });

  it('switches team through a nested page, keeping the current view', async () => {
    const user = renderPalette({
      path: '/w/mine/team/ENG/cycles',
      teams: [engine, design],
    });

    await user.keyboard('{Control>}k{/Control}');
    await user.click(
      await screen.findByRole('option', { name: /Switch team/ })
    );

    expect(
      await screen.findByRole('combobox', { name: 'Switch to a team' })
    ).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /Design/ }));

    expect(navigate).toHaveBeenCalledWith('/w/mine/team/DES/cycles');
  });

  it('leaves out switch team when there is only one', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('option', { name: /My issues/ });

    expect(
      screen.queryByRole('option', { name: /Switch team/ })
    ).not.toBeInTheDocument();
  });

  it('runs the focused issue shortcuts by name', async () => {
    const action = vi.fn();
    const user = renderPalette({
      path: '/w/mine/issues/ENG-12',
      issueAction: action,
    });

    await user.keyboard('{Control>}k{/Control}');
    const row = await screen.findByRole('option', { name: /Change status/ });
    expect(screen.getAllByText('ENG-12').length).toBeGreaterThan(0);
    await user.click(row);

    await waitFor(() => {
      expect(action).toHaveBeenCalled();
    });
  });
});
