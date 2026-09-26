/**
 * The shortcuts that work anywhere in a workspace: `C` to create an issue,
 * `G` then a letter to go somewhere, `/` to search and `?` for the list of
 * every shortcut. Registered through the same registry as any page's own
 * shortcuts, so the help overlay and the command palette list them without a
 * second source of truth.
 */

import type React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useCreateIssue } from '../../hooks/useCreateIssue';
import { useShortcut } from '../../hooks/useShortcuts';
import { currentOrFirstTeam, settingsLanding } from '../../lib/workspaceNav';
import {
  inboxPath,
  myIssuesPath,
  projectsPath,
  roadmapPath,
  routeTeamPrefix,
  searchPath,
  teamCyclesPath,
  teamPath,
  viewsPath,
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
  const slug = workspace.slug;
  const team = currentOrFirstTeam(
    teams,
    routeTeamPrefix(location.pathname, location.search)
  );

  const go = (to: string) => () => {
    void navigate(to);
  };

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
    label: 'Go to views',
    group: NAVIGATION,
    handler: go(viewsPath(slug)),
  });
  useShortcut({
    keys: '/',
    label: 'Search',
    handler: () => {
      focusSearch(go(searchPath(slug)));
    },
  });
  useShortcut({
    keys: '?',
    label: 'Show keyboard shortcuts',
    handler: onShowHelp,
  });

  return null;
};

export default GlobalShortcuts;
