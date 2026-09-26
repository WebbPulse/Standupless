/**
 * What the command palette answers with: the shortcut that opens it, the
 * keystrokes it refuses to steal, the highlight the arrow keys move, and what
 * Enter resolves to for a navigation command, an issue key and a search hit.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchResultRead, TeamRead } from '../../types/Api';
import { useCommandPalette } from '../../hooks/useCommandPalette';
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

/**
 * The palette wired to the hook, with a text field beside it so a test can
 * type somewhere the shortcut must not fire.
 */
const Harness: React.FC = () => {
  const { open, closePalette } = useCommandPalette();
  return (
    <MemoryRouter initialEntries={['/w/mine']}>
      <input aria-label="Issue title" />
      <CommandPalette
        open={open}
        onClose={closePalette}
        workspaceId="ws-1"
        slug="mine"
        teams={[engine]}
      />
    </MemoryRouter>
  );
};

/** Renders the harness and returns a user-event session bound to it. */
const renderPalette = () => {
  const user = userEvent.setup();
  render(<Harness />);
  return user;
};

beforeEach(() => {
  search.mockReset();
  navigate.mockReset();
  search.mockResolvedValue([]);
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

    const first = await screen.findByRole('option', { name: /My issues/ });
    expect(first).toHaveAttribute('aria-selected', 'true');
  });

  it('moves down and up with the arrow keys', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('option', { name: /My issues/ });

    await user.keyboard('{ArrowDown}');
    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Inbox/ })).toHaveAttribute(
        'aria-selected',
        'true'
      );
    });

    await user.keyboard('{ArrowUp}');
    await waitFor(() => {
      expect(screen.getByRole('option', { name: /My issues/ })).toHaveAttribute(
        'aria-selected',
        'true'
      );
    });
  });

  it('wraps to the last row when it moves up off the top', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('option', { name: /My issues/ });

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
    const first = await screen.findByRole('option', { name: /My issues/ });

    expect(
      screen.getByRole('combobox', { name: 'Type a command or search' })
    ).toHaveAttribute('aria-activedescendant', first.id);
  });
});

describe('activating a row', () => {
  it('navigates on Enter and closes', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
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
