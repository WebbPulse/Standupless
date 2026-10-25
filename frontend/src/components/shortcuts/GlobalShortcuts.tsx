/**
 * The shortcuts that work anywhere in a workspace: `C` to create an issue,
 * `V` to create one in fullscreen,
 * Alt+C to pick a template of the team in context and create from it,
 * `G` then a letter to go somewhere: the team's active issues, backlog,
 * board, archive, cycles and, as in Linear, `G` then `V` for its current
 * cycle and `G` then `W` for its upcoming one among them, with `G` then
 * Shift+V for views, Ctrl+Shift+1 to 9 for the teams in sidebar order,
 * `O` then `M` for the viewer's own member page,
 * `O` then a letter to open a favorite, project, cycle, team, view, member or
 * workspace from a picker, `/` to search, Ctrl+Z to undo the last issue change and `?` for the
 * list of every shortcut. Registered through the
 * same registry as any page's own shortcuts, so the help overlay and the
 * command palette list them without a second source of truth.
 */

import type React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  usePaletteControls,
  type PalettePicker,
} from '../../hooks/useCommandPalette';
import {
  CREATE_FROM_TEMPLATE_KEYS,
  CREATE_FULLSCREEN_KEYS,
  useCreateIssue,
} from '../../hooks/useCreateIssue';
import { useShortcut } from '../../hooks/useShortcuts';
import {
  SIDEBAR_TOGGLE_KEYS,
  toggleSidebarCollapsed,
} from '../../hooks/useSidebarLayout';
import { UNDO_KEYS, UNDO_LABEL, useUndo } from '../../hooks/useUndo';
import {
  currentOrFirstTeam,
  routeTeam,
  settingsLanding,
  viewsLanding,
} from '../../lib/workspaceNav';
import {
  inboxPath,
  memberPath,
  myIssuesPath,
  projectsPath,
  roadmapPath,
  routeTeamPrefix,
  searchPath,
  teamArchivePath,
  teamBoardPath,
  teamCurrentCyclePath,
  teamCyclesPath,
  teamPath,
  teamTriagePath,
} from '../../lib/paths';
import { openUpcomingCycle } from '../../lib/currentCycle';
import { teamScopePath } from '../../lib/teamIssueScope';
import {
  TEAM_SHORTCUT_COUNT,
  TEAM_SHORTCUT_LABEL,
  teamAtPosition,
  teamShortcutKeys,
} from '../../lib/teamShortcuts';
import type { TeamRead, WorkspaceRead } from '../../types/Api';

/** Props for GlobalShortcuts. */
export interface GlobalShortcutsProps {
  workspace: WorkspaceRead;
  teams: readonly TeamRead[];
  /** The viewer, whose member page `O` then `M` opens. */
  currentUserId?: string | undefined;
  /** Opens the list of every shortcut. */
  onShowHelp: () => void;
}

/** The heading the navigation shortcuts are listed under. */
const NAVIGATION = 'Navigation';

/** The heading the open picker shortcuts are listed under. */
const OPEN = 'Open';

/**
 * Focuses the search field on the page when there is one, otherwise opens the
 * search page, so `/` always ends with the caret in a search box.
 */
const focusSearch = (go: () => void): void => {
  const field = globalThis.document.querySelector<HTMLInputElement>(
    'main input[type="search"]'
  );
  if (field === null) {
    go();
    return;
  }
  field.focus();
  field.select();
};

/** The 1-based sidebar positions that have a team shortcut. */
const TEAM_POSITIONS = Array.from(
  { length: TEAM_SHORTCUT_COUNT },
  (_, index) => index + 1
);

/** Props for TeamShortcut. */
interface TeamShortcutProps {
  slug: string;
  teams: readonly TeamRead[];
  position: number;
}

/** Binds Ctrl+Shift and one digit to the team at that sidebar position. */
const TeamShortcut: React.FC<TeamShortcutProps> = ({
  slug,
  teams,
  position,
}) => {
  const navigate = useNavigate();
  const team = teamAtPosition(teams, position);
  useShortcut({
    keys: teamShortcutKeys(position),
    label: TEAM_SHORTCUT_LABEL,
    group: NAVIGATION,
    handler: () => {
      if (team !== undefined) void navigate(teamPath(slug, team.key_prefix));
    },
    enabled: team !== undefined,
  });
  return null;
};

/** Registers the workspace-wide shortcuts. Renders nothing visible. */
export const GlobalShortcuts: React.FC<GlobalShortcutsProps> = ({
  workspace,
  teams,
  currentUserId,
  onShowHelp,
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const createIssue = useCreateIssue();
  const undo = useUndo(workspace.id);
  const slug = workspace.slug;
  const routePrefix = routeTeamPrefix(location.pathname, location.search);
  const team = currentOrFirstTeam(teams, routePrefix);
  const insideTeam = routeTeam(teams, routePrefix);

  const go = (to: string) => () => {
    void navigate(to);
  };

  const palette = usePaletteControls();
  const pick = (picker: PalettePicker) => () => {
    palette?.openPicker(picker);
  };
  const canPick = palette !== null;

  useShortcut({
    keys: 'c',
    label: 'Create issue',
    handler: () => {
      createIssue.open();
    },
    enabled: createIssue.canCreate,
  });
  useShortcut({
    keys: CREATE_FULLSCREEN_KEYS,
    label: 'Create issue in fullscreen',
    handler: () => {
      createIssue.open({ expanded: true });
    },
    enabled: createIssue.canCreate,
  });
  useShortcut({
    keys: CREATE_FROM_TEMPLATE_KEYS,
    label: 'Create issue from template',
    handler: pick('template'),
    enabled: createIssue.canCreate && canPick && team !== undefined,
  });
  useShortcut({
    keys: 'g i',
    label: 'Go to inbox',
    group: NAVIGATION,
    handler: go(inboxPath(slug)),
  });
  useShortcut({
    keys: 'g m',
    label: 'Go to my issues',
    group: NAVIGATION,
    handler: go(myIssuesPath(slug)),
  });
  useShortcut({
    keys: 'g t',
    label: 'Go to triage',
    group: NAVIGATION,
    handler: go(
      team === undefined ? '' : teamTriagePath(slug, team.key_prefix)
    ),
    enabled: team !== undefined,
  });
  useShortcut({
    keys: 'g e',
    label: 'Go to team issues',
    group: NAVIGATION,
    handler: go(team === undefined ? '' : teamPath(slug, team.key_prefix)),
    enabled: team !== undefined,
  });
  useShortcut({
    keys: 'g p',
    label: 'Go to projects',
    group: NAVIGATION,
    handler: go(projectsPath(slug)),
  });
  useShortcut({
    keys: 'g c',
    label: 'Go to cycles',
    group: NAVIGATION,
    handler: go(
      team === undefined ? '' : teamCyclesPath(slug, team.key_prefix)
    ),
    enabled: team !== undefined,
  });
  useShortcut({
    keys: 'g a',
    label: 'Go to active issues',
    group: NAVIGATION,
    handler: go(
      team === undefined ? '' : teamScopePath(slug, team.key_prefix, 'active')
    ),
    enabled: team !== undefined,
  });
  useShortcut({
    keys: 'g b',
    label: 'Go to backlog',
    group: NAVIGATION,
    handler: go(
      team === undefined ? '' : teamScopePath(slug, team.key_prefix, 'backlog')
    ),
    enabled: team !== undefined,
  });
  useShortcut({
    keys: 'g d',
    label: 'Go to board',
    group: NAVIGATION,
    handler: go(team === undefined ? '' : teamBoardPath(slug, team.key_prefix)),
    enabled: team !== undefined,
  });
  useShortcut({
    keys: 'g x',
    label: 'Go to archived issues',
    group: NAVIGATION,
    handler: go(
      team === undefined ? '' : teamArchivePath(slug, team.key_prefix)
    ),
    enabled: team !== undefined,
  });
  useShortcut({
    keys: 'g v',
    label: 'Go to current cycle',
    group: NAVIGATION,
    handler: go(
      team === undefined ? '' : teamCurrentCyclePath(slug, team.key_prefix)
    ),
    enabled: team !== undefined,
  });
  useShortcut({
    keys: 'g w',
    label: 'Go to upcoming cycle',
    group: NAVIGATION,
    handler: () => {
      if (team === undefined) return;
      void openUpcomingCycle({
        workspaceId: workspace.id,
        slug,
        team,
        navigate: (to) => {
          void navigate(to);
        },
      });
    },
    enabled: team !== undefined,
  });
  useShortcut({
    keys: 'g r',
    label: 'Go to roadmap',
    group: NAVIGATION,
    handler: go(roadmapPath(slug)),
  });
  useShortcut({
    keys: 'g s',
    label: 'Go to settings',
    group: NAVIGATION,
    handler: go(settingsLanding(workspace)),
  });
  useShortcut({
    keys: 'g shift+v',
    label: insideTeam === undefined ? 'Go to views' : 'Go to team views',
    group: NAVIGATION,
    handler: go(viewsLanding(slug, insideTeam)),
  });
  useShortcut({
    keys: SIDEBAR_TOGGLE_KEYS,
    label: 'Toggle sidebar',
    group: NAVIGATION,
    handler: toggleSidebarCollapsed,
  });
  useShortcut({
    keys: 'o f',
    label: 'Open favorite',
    group: OPEN,
    handler: pick('favorites'),
    enabled: canPick,
  });
  useShortcut({
    keys: 'o p',
    label: 'Open project',
    group: OPEN,
    handler: pick('projects'),
    enabled: canPick,
  });
  useShortcut({
    keys: 'o c',
    label: 'Open cycle',
    group: OPEN,
    handler: pick('cycles'),
    enabled: canPick && team !== undefined,
  });
  useShortcut({
    keys: 'o t',
    label: 'Open team',
    group: OPEN,
    handler: pick('teams'),
    enabled: canPick && teams.length > 0,
  });
  useShortcut({
    keys: 'o v',
    label: 'Open view',
    group: OPEN,
    handler: pick('views'),
    enabled: canPick,
  });
  useShortcut({
    keys: 'o m',
    label: 'Open my profile',
    group: OPEN,
    handler: go(
      currentUserId === undefined ? '' : memberPath(slug, currentUserId)
    ),
    enabled: currentUserId !== undefined,
  });
  useShortcut({
    keys: 'o u',
    label: 'Open member',
    group: OPEN,
    handler: pick('members'),
    enabled: canPick,
  });
  useShortcut({
    keys: 'o w',
    label: 'Switch workspace',
    group: OPEN,
    handler: pick('workspaces'),
    enabled: canPick,
  });
  useShortcut({
    keys: '/',
    label: 'Search',
    handler: () => {
      focusSearch(go(searchPath(slug)));
    },
  });
  useShortcut({
    keys: UNDO_KEYS,
    label: UNDO_LABEL,
    handler: undo.undo,
    enabled: undo.canUndo,
  });
  useShortcut({
    keys: '?',
    label: 'Show keyboard shortcuts',
    handler: onShowHelp,
  });

  return (
    <>
      {TEAM_POSITIONS.map((position) => (
        <TeamShortcut
          key={position}
          slug={slug}
          teams={teams}
          position={position}
        />
      ))}
    </>
  );
};

export default GlobalShortcuts;
