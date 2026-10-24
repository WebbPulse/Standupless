/**
 * The shortcuts that work anywhere in a workspace: `C` to create an issue,
 * `G` then a letter to go somewhere, the team's current cycle among them,
 * `O` then a letter to open a favorite, project, cycle, team or view from a
 * picker, `/` to search, Ctrl+Z to undo the last issue change and `?` for the
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
import { useCreateIssue } from '../../hooks/useCreateIssue';
import { useShortcut } from '../../hooks/useShortcuts';
import { UNDO_KEYS, UNDO_LABEL, useUndo } from '../../hooks/useUndo';
import {
  currentOrFirstTeam,
  routeTeam,
  settingsLanding,
  viewsLanding,
} from '../../lib/workspaceNav';
import {
  inboxPath,
  myIssuesPath,
  projectsPath,
  roadmapPath,
  routeTeamPrefix,
  searchPath,
  teamCurrentCyclePath,
  teamCyclesPath,
  teamPath,
  teamTriagePath,
} from '../../lib/paths';
import type { TeamRead, WorkspaceRead } from '../../types/Api';

/** Props for GlobalShortcuts. */
export interface GlobalShortcutsProps {
  workspace: WorkspaceRead;
  teams: readonly TeamRead[];
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

/** Registers the workspace-wide shortcuts. Renders nothing. */
export const GlobalShortcuts: React.FC<GlobalShortcutsProps> = ({
  workspace,
  teams,
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
    label: 'Go to current cycle',
    group: NAVIGATION,
    handler: go(
      team === undefined ? '' : teamCurrentCyclePath(slug, team.key_prefix)
    ),
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
    keys: 'g v',
    label: insideTeam === undefined ? 'Go to views' : 'Go to team views',
    group: NAVIGATION,
    handler: go(viewsLanding(slug, insideTeam)),
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

  return null;
};

export default GlobalShortcuts;
