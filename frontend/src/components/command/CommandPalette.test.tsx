/**
 * What the command palette answers with: the shortcut that opens it, the
 * keystrokes it refuses to steal, the highlight the arrow keys move, what
 * Enter resolves to for a navigation command, an issue key and a search hit,
 * and the actions it offers: creating an issue or a team, switching team,
 * changing the theme, the focused issue's shortcuts, and a page's own actions
 * under their group heading. Creating an issue from a template opens a page
 * listing the current team's templates. Once a term is typed it also offers
 * the settings pages and the current team's settings sections, found by their
 * synonyms, and the create project and create initiative dialogs, and it
 * ends on a row that opens full search for the term.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ShortcutProvider from '../shortcuts/ShortcutProvider';
import type {
  MemberRead,
  SearchResultRead,
  TeamRead,
  TemplateListRead,
  WorkspaceRole,
} from '../../types/Api';
import { useCommandPalette } from '../../hooks/useCommandPalette';
import {
  CreateIssueContext,
  type CreateIssueState,
} from '../../hooks/useCreateIssue';
import {
  CreatePlanningContext,
  type CreatePlanningState,
} from '../../hooks/useCreatePlanning';
import {
  CreateTeamContext,
  type CreateTeamState,
} from '../../hooks/useCreateTeam';
import { useShortcut } from '../../hooks/useShortcuts';
import { THEME_STORAGE_KEY } from '../../lib/theme';
import type { SavedViewDisplayRead } from '../../api/views';
import CommandPalette from './CommandPalette';

const search = vi.fn<(q?: string) => Promise<SearchResultRead[]>>();
const listViews = vi.fn<() => Promise<SavedViewDisplayRead[]>>();
const navigate = vi.fn();
const listTeamTemplates =
  vi.fn<(workspaceId: string, teamId: string) => Promise<TemplateListRead>>();

const workspaceMembers = vi.fn<() => MemberRead[]>(() => []);

vi.mock('../../hooks/useWorkspaceMembers', () => ({
  useWorkspaceMembers: () => workspaceMembers(),
}));

vi.mock('../../api/documents', () => ({
  listWorkspaceDocuments: () => Promise.resolve([]),
}));

vi.mock('../../api/views', () => ({
  search: (_w: string, q: string) => search(q),
  listViews: () => listViews(),
}));

vi.mock('../../api/templates', () => ({
  listTeamTemplates: (workspaceId: string, teamId: string) =>
    listTeamTemplates(workspaceId, teamId),
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
  createPlanning?: CreatePlanningState;
  role?: WorkspaceRole;
  issueAction?: () => void;
  pageAction?: () => void;
  workspaces?: { id: string; slug: string; name: string }[];
  onLogOut?: () => void;
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

/** Registers one page action, as a project page would. */
const PageShortcut: React.FC<{ run: () => void }> = ({ run }) => {
  useShortcut({
    keys: 'shift+u',
    label: 'Post project update',
    scope: 'page',
    group: 'Project',
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
  createPlanning,
  role = 'owner',
  issueAction,
  pageAction,
  workspaces,
  onLogOut,
}) => {
  const { open, closePalette } = useCommandPalette();
  let tree: React.ReactNode = (
    <>
      <input aria-label="Issue title" />
      {issueAction !== undefined && <IssueShortcut run={issueAction} />}
      {pageAction !== undefined && <PageShortcut run={pageAction} />}
      <CommandPalette
        open={open}
        onClose={closePalette}
        workspace={{ id: 'ws-1', slug: 'mine', role }}
        teams={teams}
        {...(workspaces === undefined ? {} : { workspaces })}
        {...(onLogOut === undefined ? {} : { onLogOut })}
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
  if (createPlanning !== undefined) {
    tree = (
      <CreatePlanningContext.Provider value={createPlanning}>
        {tree}
      </CreatePlanningContext.Provider>
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

/** Planning dialogs whose openers are spies, both allowed. */
const planningDialogs = (): CreatePlanningState => ({
  openProject: vi.fn(),
  openInitiative: vi.fn(),
  canCreateProject: true,
  canCreateInitiative: true,
});

beforeEach(() => {
  search.mockReset();
  navigate.mockReset();
  listViews.mockReset();
  listViews.mockResolvedValue([]);
  listTeamTemplates.mockReset();
  listTeamTemplates.mockResolvedValue({
    templates: [],
    default_template_id: null,
  });
  search.mockResolvedValue([]);
  workspaceMembers.mockReturnValue([]);
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

  it('finds a place by an abbreviation or a typo and highlights the match', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('rdmp');

    const row = await screen.findByRole('option', { name: /Roadmap/ });
    expect(row.querySelector('span.font-medium')?.textContent).toBe('R');

    await user.clear(screen.getByRole('combobox'));
    await user.keyboard('raodmap');

    expect(
      await screen.findByRole('option', { name: /Roadmap/ })
    ).toBeInTheDocument();
  });

  it('puts the closest match first within its section', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('views');

    const group = await screen.findByRole('group', { name: 'Go to' });
    const rows = within(group).getAllByRole('option');
    expect(rows[0]).toHaveAccessibleName(/^Go to Views/);
  });

  it('finds Pulse by name and by what it holds', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('initiative updates');

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Pulse/ })).toBeInTheDocument();
    });
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

  it('opens the Activity tab of My issues', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('my activity');
    await user.click(
      await screen.findByRole('option', { name: /My activity/ })
    );

    expect(navigate).toHaveBeenCalledWith('/w/mine/issues?tab=activity');
  });

  it('navigates on a click', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');

    await user.click(await screen.findByRole('option', { name: /Roadmap/ }));

    expect(navigate).toHaveBeenCalledWith('/w/mine/roadmap');
  });
});

describe('what a term resolves to', () => {
  it('opens the MCP setup for "Connect an AI assistant"', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('assistant');
    await screen.findByRole('option', { name: /Connect an AI assistant/ });

    await user.keyboard('{Enter}');

    expect(navigate).toHaveBeenCalledWith('/w/mine/settings/mcp-and-cli#mcp');
  });

  it('finds the MCP setup by the word mcp', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('mcp');

    expect(
      await screen.findByRole('option', { name: /Connect an AI assistant/ })
    ).toBeInTheDocument();
  });

  it('opens the CLI setup for "Install the CLI"', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await user.click(
      await screen.findByRole('option', { name: /Install the CLI/ })
    );

    expect(navigate).toHaveBeenCalledWith('/w/mine/settings/mcp-and-cli#cli');
  });

  it('offers the issue directly for an exact key, without searching', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('eng-12');

    expect(
      await screen.findByRole('option', { name: /Go to ENG-12/ })
    ).toBeInTheDocument();
    expect(search.mock.calls.map((call) => call[0])).not.toContain('eng-12');

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

  it('ends on a row that opens full search for the term', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('signing keys');

    const row = await screen.findByRole('option', {
      name: /Search for "signing keys"/,
    });
    const rows = screen.getAllByRole('option');
    expect(rows[rows.length - 1]).toBe(row);

    await user.click(row);

    expect(navigate).toHaveBeenCalledWith('/w/mine/search?q=signing+keys');
  });

  it('keeps the exact issue key ahead of the search row', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('eng-12');

    await screen.findByRole('option', { name: /Search for "eng-12"/ });
    expect(screen.getAllByRole('option')[0]).toHaveAccessibleName(
      /Go to ENG-12/
    );
  });

  it('offers no search row without a term', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('option', { name: /Switch to light theme/ });

    expect(
      screen.queryByRole('option', { name: /^Search for/ })
    ).not.toBeInTheDocument();
  });

  it('waits for a second character rather than searching one', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('~');

    await waitFor(() => {
      expect(screen.getByText(/at least 2 characters/)).toBeInTheDocument();
    });
    expect(search).not.toHaveBeenCalled();
  });
});

describe('the actions', () => {
  it('opens the create issue dialog when the caller may write issues', async () => {
    const dialog = issueDialog();
    const user = renderPalette({ createIssue: dialog });

    await user.keyboard('{Control>}k{/Control}');
    const [createRow] = await screen.findAllByRole('option', {
      name: /Create new issue/,
    });
    if (createRow === undefined) throw new Error('no Create issue row');
    await user.click(createRow);

    await waitFor(() => {
      expect(dialog.open).toHaveBeenCalledWith();
    });
  });

  it('opens the create issue dialog expanded from the fullscreen action', async () => {
    const dialog = issueDialog();
    const user = renderPalette({ createIssue: dialog });

    await user.keyboard('{Control>}k{/Control}');
    await user.click(
      await screen.findByRole('option', { name: /Create issue in fullscreen/ })
    );

    await waitFor(() => {
      expect(dialog.open).toHaveBeenCalledWith({ expanded: true });
    });
  });

  it('creates an issue from a template of the current team', async () => {
    listTeamTemplates.mockResolvedValue({
      templates: [
        {
          id: 'tp-1',
          name: 'Bug report',
          team_id: 'team-1',
          scope: 'team',
          title: 'Bug: ',
          body: null,
          status_id: null,
          priority: null,
          assignee_id: null,
          label_ids: [],
          estimate: null,
          project_id: null,
          project_milestone_id: null,
          cycle_id: null,
          position: 0,
          created_by: 'user-1',
          created_at: '2026-10-10T00:00:00Z',
          updated_at: '2026-10-10T00:00:00Z',
        },
      ],
      default_template_id: null,
    });
    const dialog = issueDialog();
    const user = renderPalette({ createIssue: dialog });

    await user.keyboard('{Control>}k{/Control}');
    await user.click(
      await screen.findByRole('option', { name: /Create issue from template/ })
    );

    expect(
      await screen.findByRole('combobox', { name: 'Pick a template' })
    ).toBeInTheDocument();
    await user.click(await screen.findByRole('option', { name: /Bug report/ }));

    await waitFor(() => {
      expect(dialog.open).toHaveBeenCalledWith({
        teamId: 'team-1',
        templateId: 'tp-1',
      });
    });
    expect(listTeamTemplates).toHaveBeenCalledWith('ws-1', 'team-1');
  });

  it('says so when the team has no templates', async () => {
    const user = renderPalette({ createIssue: issueDialog() });

    await user.keyboard('{Control>}k{/Control}');
    await user.click(
      await screen.findByRole('option', { name: /Create issue from template/ })
    );

    expect(
      await screen.findByText('This team has no templates yet.')
    ).toBeInTheDocument();
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
    const user = renderPalette({
      createTeam: { open, openSubTeam: vi.fn(), canCreate: true },
    });

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('create team');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(open).toHaveBeenCalled();
    });
  });

  it('creates a sub-team by asking for its parent, offering only top-level teams', async () => {
    const openSubTeam = vi.fn();
    const mobile: TeamRead = {
      ...engine,
      id: 'team-3',
      name: 'Mobile',
      key_prefix: 'MOB',
      parent_team_id: 'team-1',
    };
    const user = renderPalette({
      teams: [engine, mobile, design],
      createTeam: { open: vi.fn(), openSubTeam, canCreate: true },
    });

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('sub-team');
    await user.click(
      await screen.findByRole('option', { name: /Create sub-team/ })
    );

    expect(
      await screen.findByRole('combobox', { name: 'Pick the parent team' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: /Mobile/ })
    ).not.toBeInTheDocument();
    await user.keyboard('des');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(openSubTeam).toHaveBeenCalledWith('team-2');
    });
  });

  it('offers no Create sub-team to a role that cannot create teams', async () => {
    const user = renderPalette({
      createTeam: { open: vi.fn(), openSubTeam: vi.fn(), canCreate: false },
    });

    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('option', { name: /My issues/ });

    expect(
      screen.queryByRole('option', { name: /Create sub-team/ })
    ).not.toBeInTheDocument();
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

  it('switches workspace through a nested page that leaves out the current one', async () => {
    const user = renderPalette({
      workspaces: [
        { id: 'ws-1', slug: 'mine', name: 'Mine' },
        { id: 'ws-2', slug: 'acme', name: 'Acme' },
        { id: 'ws-3', slug: 'globex', name: 'Globex' },
      ],
    });

    await user.keyboard('{Control>}k{/Control}');
    await user.click(
      await screen.findByRole('option', { name: /Switch workspace/ })
    );

    const field = await screen.findByRole('combobox', {
      name: 'Switch to a workspace',
    });
    expect(
      screen.queryByRole('option', { name: /^Mine/ })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Globex/ })).toBeInTheDocument();
    await user.type(field, 'acm');
    expect(
      screen.queryByRole('option', { name: /Globex/ })
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /Acme/ }));

    expect(navigate).toHaveBeenCalledWith('/w/acme');
  });

  it('offers to create a workspace when the viewer has only this one', async () => {
    const user = renderPalette({
      workspaces: [{ id: 'ws-1', slug: 'mine', name: 'Mine' }],
    });

    await user.keyboard('{Control>}k{/Control}');
    await user.click(
      await screen.findByRole('option', { name: /Switch workspace/ })
    );
    await user.click(
      await screen.findByRole('option', { name: /Create workspace/ })
    );

    expect(navigate).toHaveBeenCalledWith('/workspaces/new');
  });

  it('logs out by name', async () => {
    const onLogOut = vi.fn();
    const user = renderPalette({ onLogOut });

    await user.keyboard('{Control>}k{/Control}');
    await user.click(await screen.findByRole('option', { name: /Log out/ }));

    await waitFor(() => {
      expect(onLogOut).toHaveBeenCalled();
    });
  });

  it('opens the new view composer for "Create view"', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await user.click(
      await screen.findByRole('option', { name: /Create view/ })
    );

    expect(navigate).toHaveBeenCalledWith('/w/mine/views/new');
  });

  it('opens a saved view through a nested page', async () => {
    listViews.mockResolvedValue([
      {
        view_id: 'view-1',
        name: 'Hot bugs',
        layout: 'list',
      } as SavedViewDisplayRead,
      {
        view_id: 'view-2',
        name: 'Release board',
        layout: 'board',
      } as SavedViewDisplayRead,
    ]);
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await user.click(await screen.findByRole('option', { name: /Open view/ }));

    expect(
      await screen.findByRole('combobox', { name: 'Open a saved view' })
    ).toBeInTheDocument();
    await user.keyboard('release');
    await waitFor(() => {
      expect(
        screen.queryByRole('option', { name: /Hot bugs/ })
      ).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole('option', { name: /Release board/ }));

    expect(navigate).toHaveBeenCalledWith('/w/mine/views/view-2');
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

  it('runs a page action by name under its group', async () => {
    const action = vi.fn();
    const user = renderPalette({
      path: '/w/mine/projects/prj-1',
      pageAction: action,
    });

    await user.keyboard('{Control>}k{/Control}');
    const group = await screen.findByRole('group', { name: 'Project' });
    const row = await screen.findByRole('option', {
      name: /Post project update/,
    });
    expect(group).toContainElement(row);
    await user.click(row);

    await waitFor(() => {
      expect(action).toHaveBeenCalled();
    });
  });
});

describe('the settings commands', () => {
  it('finds notification settings by the word notifications', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('notifications');
    const group = await screen.findByRole('group', { name: 'Settings' });
    const row = await screen.findByRole('option', {
      name: /Notification settings/,
    });
    expect(group).toContainElement(row);
    await user.click(row);

    expect(navigate).toHaveBeenCalledWith('/w/mine/settings/notifications');
  });

  it('finds a settings page by a synonym its label lacks', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('invoices');
    await user.click(
      await screen.findByRole('option', { name: /Billing and plan/ })
    );

    expect(navigate).toHaveBeenCalledWith('/w/mine/settings/billing');
  });

  it('opens a section of the current team settings on its anchor', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('service level');
    const group = await screen.findByRole('group', {
      name: 'Engine settings',
    });
    const row = await screen.findByRole('option', { name: /SLA settings/ });
    expect(group).toContainElement(row);
    await user.click(row);

    expect(navigate).toHaveBeenCalledWith(
      '/w/mine/team/ENG/settings#team-settings-sla'
    );
  });

  it('keeps the admin settings pages from a member', async () => {
    const user = renderPalette({ role: 'member' });

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('settings');
    await screen.findByRole('option', { name: /Notification settings/ });

    expect(
      screen.queryByRole('option', { name: /Import issues/ })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: /Audit log/ })
    ).not.toBeInTheDocument();
  });

  it('offers the admin settings pages to an owner', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('import');
    await user.click(
      await screen.findByRole('option', { name: /Import issues/ })
    );

    expect(navigate).toHaveBeenCalledWith('/w/mine/settings/import');
  });

  it('shows no settings rows before a term is typed', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('option', { name: /My issues/ });

    expect(
      screen.queryByRole('option', { name: /Notification settings/ })
    ).not.toBeInTheDocument();
  });
});

describe('the planning commands', () => {
  it('goes to Initiatives', async () => {
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('goals');
    await user.click(
      await screen.findByRole('option', { name: /Initiatives/ })
    );

    expect(navigate).toHaveBeenCalledWith('/w/mine/initiatives');
  });

  it('leaves Initiatives out for a guest', async () => {
    const user = renderPalette({ role: 'guest' });

    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('option', { name: /My issues/ });

    expect(
      screen.queryByRole('option', { name: /Initiatives/ })
    ).not.toBeInTheDocument();
  });

  it('opens the create project dialog', async () => {
    const dialogs = planningDialogs();
    const user = renderPalette({ createPlanning: dialogs });

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('create project');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(dialogs.openProject).toHaveBeenCalled();
    });
  });

  it('opens the create initiative dialog', async () => {
    const dialogs = planningDialogs();
    const user = renderPalette({ createPlanning: dialogs });

    await user.keyboard('{Control>}k{/Control}');
    await user.click(
      await screen.findByRole('option', { name: /Create initiative/ })
    );

    await waitFor(() => {
      expect(dialogs.openInitiative).toHaveBeenCalled();
    });
  });

  it('leaves out the create commands the caller may not use', async () => {
    const user = renderPalette({
      createPlanning: {
        ...planningDialogs(),
        canCreateProject: false,
        canCreateInitiative: false,
      },
    });

    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('option', { name: /My issues/ });

    expect(
      screen.queryByRole('option', { name: /Create project/ })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: /Create initiative/ })
    ).not.toBeInTheDocument();
  });
});

describe('the team preset commands', () => {
  it('opens the current team on its active issues and its backlog', async () => {
    const user = renderPalette({ path: '/w/mine/team/ENG' });

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('active issues');
    await user.click(
      await screen.findByRole('option', { name: /Go to active issues/ })
    );

    expect(navigate).toHaveBeenCalledWith('/w/mine/team/ENG?scope=active');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('go to backlog');
    await user.click(
      await screen.findByRole('option', { name: /Go to backlog/ })
    );

    expect(navigate).toHaveBeenCalledWith('/w/mine/team/ENG?scope=backlog');
  });
});

describe('going to a member', () => {
  it('finds a person by name and opens their member page', async () => {
    workspaceMembers.mockReturnValue([
      {
        user_id: 'user-7',
        email: 'riley@example.com',
        display_name: 'riley',
        full_name: 'Riley Chen',
        role: 'member',
        joined_at: '2026-09-17T00:00:00Z',
      },
    ]);
    const user = renderPalette();

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('chen');
    const row = await screen.findByRole('option', {
      name: /Go to member riley/,
    });
    expect(row).not.toHaveTextContent('example.com');

    await user.click(row);

    expect(navigate).toHaveBeenCalledWith('/w/mine/members/user-7');
  });
});

describe('the team go-to commands', () => {
  it.each([
    ['active issues', /Go to active issues/, 'G then A'],
    ['go to backlog', /Go to backlog/, 'G then B'],
    ['Engine board', /Engine board/, 'G then D'],
    ['archived issues', /Engine archived issues/, 'G then X'],
    ['Engine views', /Engine views/, 'G then Shift V'],
  ])('shows %s with its keys', async (term, name, keys) => {
    const user = renderPalette({ path: '/w/mine/team/ENG' });

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard(term);

    const option = await screen.findByRole('option', { name });
    expect(option).toHaveTextContent(keys);
  });

  it('opens the current team board', async () => {
    const user = renderPalette({ path: '/w/mine/team/ENG' });

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('Engine board');
    await user.click(
      await screen.findByRole('option', { name: /Engine board/ })
    );

    expect(navigate).toHaveBeenCalledWith('/w/mine/team/ENG/board');
  });
});
