/**
 * The workspace sidebar: the workspace menu at the top, the places a person
 * works in the middle, the project they are in when the route names one, and
 * the account row at the bottom. Rendered as the fixed rail on wide screens
 * and inside a drawer on phones.
 */

import React from 'react';
import {
  LuChevronsUpDown,
  LuFolder,
  LuInbox,
  LuLayers,
  LuList,
  LuLogOut,
  LuMap,
  LuMilestone,
  LuSearch,
  LuSettings,
  LuSquareKanban,
  LuUserRound,
} from 'react-icons/lu';
import { NavLink, useParams } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { canManageMembers } from '../../lib/capabilities';
import { cn } from '../../lib/cn';
import type { WorkspaceRead } from '../../types/Api';
import Avatar from '../ui/avatar';
import { IconButton } from '../ui/button';
import Menu, { MenuItem, MenuSeparator } from '../ui/menu';
import ThemeToggle from '../ui/theme-toggle';
import InboxBadge from '../views/InboxBadge';

/** Props for Sidebar: the workspace and what to do when a link is followed. */
export interface SidebarProps {
  workspace: WorkspaceRead;
  /** Called after any link is followed, so a drawer can close. */
  onNavigate?: () => void;
}

const itemClass = ({ isActive }: { isActive: boolean }): string =>
  cn(
    'flex h-7 items-center gap-2 rounded-sm px-2 text-sm transition-colors duration-100',
    isActive
      ? 'bg-raised font-medium text-text'
      : 'text-text-muted hover:bg-raised/70 hover:text-text'
  );

const ICON = 'h-4 w-4 shrink-0';

/** The key prefix the current route is inside, from a project or an issue key. */
const currentPrefix = (params: {
  keyPrefix?: string;
  key?: string;
}): string | null => {
  if (params.keyPrefix !== undefined) return params.keyPrefix;
  if (params.key !== undefined) return params.key.split('-')[0] ?? null;
  return null;
};

/** The workspace navigation column. */
export const Sidebar: React.FC<SidebarProps> = ({ workspace, onNavigate }) => {
  const { user, logout } = useAuth();
  const params = useParams<{ keyPrefix?: string; key?: string }>();
  const prefix = currentPrefix(params);
  const base = `/w/${workspace.slug}`;

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex h-topbar items-center px-2">
        <Menu
          label="Workspace"
          className="min-w-0 flex-1"
          trigger={(props) => (
            <button
              type="button"
              className="flex h-8 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-left text-sm font-semibold hover:bg-raised"
              {...props}
            >
              <Avatar name={workspace.name} size="sm" className="rounded-xs" />
              <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
              <LuChevronsUpDown
                className="h-3.5 w-3.5 shrink-0 text-text-faint"
                aria-hidden="true"
              />
            </button>
          )}
        >
          <MenuItem to="/workspaces">All workspaces</MenuItem>
          <MenuItem to="/security">Account security</MenuItem>
          <MenuSeparator />
          <MenuItem onSelect={() => void logout()}>Sign out</MenuItem>
        </Menu>
      </div>

      <nav
        aria-label="Workspace"
        className="flex-1 space-y-4 overflow-y-auto px-2 py-1 scrollbar-thin"
      >
        <div className="space-y-px">
          <NavLink
            to={`${base}/inbox`}
            end
            className={itemClass}
            onClick={onNavigate}
          >
            <LuInbox className={ICON} aria-hidden="true" />
            <span className="flex-1">Inbox</span>
            <InboxBadge workspaceId={workspace.id} />
          </NavLink>
          <NavLink
            to={`${base}/issues`}
            end
            className={itemClass}
            onClick={onNavigate}
          >
            <LuUserRound className={ICON} aria-hidden="true" />
            My issues
          </NavLink>
          <NavLink
            to={`${base}/search`}
            end
            className={itemClass}
            onClick={onNavigate}
          >
            <LuSearch className={ICON} aria-hidden="true" />
            Search
          </NavLink>
          <NavLink
            to={`${base}/roadmap`}
            end
            className={itemClass}
            onClick={onNavigate}
          >
            <LuMap className={ICON} aria-hidden="true" />
            Roadmap
          </NavLink>
        </div>

        <div>
          <p className="px-2 pb-1 text-2xs font-medium text-text-faint">
            Workspace
          </p>
          <div className="space-y-px">
            <NavLink to={base} end className={itemClass} onClick={onNavigate}>
              <LuFolder className={ICON} aria-hidden="true" />
              Projects
            </NavLink>
            <NavLink
              to={
                canManageMembers(workspace.role)
                  ? `${base}/settings`
                  : `${base}/settings/api-keys`
              }
              className={itemClass}
              onClick={onNavigate}
            >
              <LuSettings className={ICON} aria-hidden="true" />
              Settings
            </NavLink>
          </div>
        </div>

        {prefix !== null && (
          <div>
            <p className="px-2 pb-1 text-2xs font-medium text-text-faint">
              Project
            </p>
            <div className="space-y-px">
              <NavLink
                to={`${base}/p/${prefix}`}
                end
                className={itemClass}
                onClick={onNavigate}
              >
                <LuList className={ICON} aria-hidden="true" />
                Issues
              </NavLink>
              <NavLink
                to={`${base}/p/${prefix}/board`}
                end
                className={itemClass}
                onClick={onNavigate}
              >
                <LuSquareKanban className={ICON} aria-hidden="true" />
                Board
              </NavLink>
              <NavLink
                to={`${base}/p/${prefix}/cycles`}
                end
                className={itemClass}
                onClick={onNavigate}
              >
                <LuLayers className={ICON} aria-hidden="true" />
                Cycles
              </NavLink>
              <NavLink
                to={`${base}/p/${prefix}/milestones`}
                end
                className={itemClass}
                onClick={onNavigate}
              >
                <LuMilestone className={ICON} aria-hidden="true" />
                Milestones
              </NavLink>
            </div>
          </div>
        )}
      </nav>

      <div className="flex h-topbar items-center gap-1 border-t border-line px-2">
        {user !== null && (
          <span className="flex min-w-0 flex-1 items-center gap-2 px-1 text-xs text-text-muted">
            <Avatar name={user.display_name ?? user.email} size="sm" />
            <span className="truncate">{user.display_name ?? user.email}</span>
          </span>
        )}
        <ThemeToggle />
        <IconButton
          label="Sign out"
          size="sm"
          onClick={() => void logout()}
          data-testid="sidebar-sign-out"
        >
          <LuLogOut className="h-3.5 w-3.5" />
        </IconButton>
      </div>
    </div>
  );
};

export default Sidebar;
