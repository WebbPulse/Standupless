/**
 * The Alt+C shortcut: it opens the command palette on the issue templates of
 * the team in context, picking one opens the create dialog from it, a team
 * with no templates offers its template settings, Option+C on a Mac fires
 * through the physical key, the keys stand down in a text field, and the
 * shortcut sheet lists it.
 */

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CommandPaletteContext,
  useCommandPalette,
} from '../../hooks/useCommandPalette';
import {
  CreateIssueContext,
  type CreateIssueState,
} from '../../hooks/useCreateIssue';
import BoundKeys from '../../test/BoundKeys';
import { keysBound } from '../../test/shortcuts';
import type {
  TeamRead,
  TemplateListRead,
  TemplateRead,
  WorkspaceRead,
} from '../../types/Api';
import GlobalShortcuts from '../shortcuts/GlobalShortcuts';
import ShortcutHelp from '../shortcuts/ShortcutHelp';
import ShortcutProvider from '../shortcuts/ShortcutProvider';
import CommandPalette from './CommandPalette';

const navigate = vi.fn();
const listTeamTemplates =
  vi.fn<(workspaceId: string, teamId: string) => Promise<TemplateListRead>>();

vi.mock('../../api/documents', () => ({
  listWorkspaceDocuments: () => Promise.resolve([]),
}));

vi.mock('../../api/views', () => ({
  search: () => Promise.resolve([]),
  listViews: () => Promise.resolve([]),
}));

vi.mock('../../api/templates', () => ({
  listTeamTemplates: (workspaceId: string, teamId: string) =>
    listTeamTemplates(workspaceId, teamId),
}));

vi.mock('../../api/favorites', () => ({
  listFavorites: () => Promise.resolve([]),
}));

vi.mock('../../api/planning', () => ({
  listProjects: () => Promise.resolve({ projects: [] }),
  listCycles: () => Promise.resolve({ cycles: [] }),
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

/** A team the shell sees. */
const team = (id: string, name: string, keyPrefix: string): TeamRead => ({
  id,
  workspace_id: 'ws-1',
  name,
  key_prefix: keyPrefix,
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  role: 'admin',
});

/** The teams the shell sees, the first of which is not the routed one. */
const teams = [
  team('team-1', 'Engine', 'ENG'),
  team('team-2', 'Design', 'DES'),
];

/** The workspace the shell is in. */
const workspace = {
  id: 'ws-1',
  slug: 'mine',
  role: 'owner',
} as WorkspaceRead;

/** An issue template of the given team. */
const template = (
  id: string,
  name: string,
  extra: Partial<TemplateRead> = {}
): TemplateRead => ({
  id,
  name,
  team_id: 'team-2',
  scope: 'team',
  title: null,
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
  ...extra,
});

/** A create issue dialog state whose open is a spy. */
const issueDialog = (): CreateIssueState => ({
  open: vi.fn(),
  close: vi.fn(),
  isOpen: false,
  canCreate: true,
  request: null,
});

/** The palette, dialog state and global shortcuts wired as the shell does. */
const Shell: React.FC<{ dialog: CreateIssueState; help: boolean }> = ({
  dialog,
  help,
}) => {
  const palette = useCommandPalette();
  return (
    <CreateIssueContext.Provider value={dialog}>
      <CommandPaletteContext.Provider value={palette}>
        <input aria-label="Issue title" />
        <GlobalShortcuts
          workspace={workspace}
          teams={teams}
          onShowHelp={() => undefined}
        />
        <CommandPalette
          open={palette.open}
          onClose={palette.closePalette}
          workspace={workspace}
          teams={teams}
          picker={palette.picker}
        />
        {help && <ShortcutHelp open onClose={() => undefined} />}
        <BoundKeys />
      </CommandPaletteContext.Provider>
    </CreateIssueContext.Provider>
  );
};

/** Renders the shell on a route and waits for Alt+C to bind. */
const renderShell = async (
  path = '/w/mine/team/DES',
  dialog = issueDialog(),
  help = false
) => {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <ShortcutProvider>
        <Shell dialog={dialog} help={help} />
      </ShortcutProvider>
    </MemoryRouter>
  );
  await keysBound('alt+c');
  return user;
};

beforeEach(() => {
  navigate.mockReset();
  listTeamTemplates.mockReset();
  listTeamTemplates.mockResolvedValue({
    templates: [],
    default_template_id: null,
  });
});

describe('Alt+C', () => {
  it("opens the routed team's templates and creates from the picked one", async () => {
    listTeamTemplates.mockResolvedValue({
      templates: [
        template('tp-1', 'Bug report'),
        template('tp-2', 'Intake form', {
          form_fields: [
            {
              key: 'broke',
              label: 'What broke?',
              type: 'short_text',
              required: true,
              options: [],
            },
          ],
        }),
      ],
      default_template_id: null,
    });
    const dialog = issueDialog();
    const user = await renderShell('/w/mine/team/DES', dialog);

    await user.keyboard('{Alt>}c{/Alt}');

    expect(
      await screen.findByRole('combobox', { name: 'Pick a template' })
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('option', { name: /Intake form/ })
    ).toBeInTheDocument();
    await user.keyboard('bug');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(dialog.open).toHaveBeenCalledWith({
        teamId: 'team-2',
        templateId: 'tp-1',
      });
    });
    expect(listTeamTemplates).toHaveBeenCalledWith('ws-1', 'team-2');
  });

  it('falls back to the first team outside a team', async () => {
    const user = await renderShell('/w/mine/inbox');

    await user.keyboard('{Alt>}c{/Alt}');

    await screen.findByRole('combobox', { name: 'Pick a template' });
    expect(listTeamTemplates).toHaveBeenCalledWith('ws-1', 'team-1');
  });

  it('fires on the physical key when Option+C types a character', async () => {
    await renderShell();

    fireEvent.keyDown(document.body, {
      key: 'ç',
      code: 'KeyC',
      altKey: true,
    });

    expect(
      await screen.findByRole('combobox', { name: 'Pick a template' })
    ).toBeInTheDocument();
  });

  it("offers the team's template settings when it has none", async () => {
    const user = await renderShell();

    await user.keyboard('{Alt>}c{/Alt}');

    expect(
      await screen.findByText('This team has no templates yet.')
    ).toBeInTheDocument();
    await user.click(
      await screen.findByRole('option', {
        name: /Set up templates in team settings/,
      })
    );

    expect(navigate).toHaveBeenCalledWith(
      '/w/mine/team/DES/settings#team-settings-templates'
    );
  });

  it('stays shut while someone is typing in a field', async () => {
    const user = await renderShell();

    await user.click(screen.getByRole('textbox', { name: 'Issue title' }));
    await user.keyboard('{Alt>}c{/Alt}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is listed in the shortcut sheet beside Create issue', async () => {
    await renderShell('/w/mine/team/DES', issueDialog(), true);

    const general = screen.getByRole('region', { name: 'General' });
    expect(within(general).getByText('Create issue')).toBeInTheDocument();
    expect(
      within(general).getByText('Create issue from template')
    ).toBeInTheDocument();
  });
});
