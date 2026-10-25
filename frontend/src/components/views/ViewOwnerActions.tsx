/**
 * Copy link and Change owner for a saved view, shared by the Views page's row
 * menu and the view's own header menu. Copy link copies the view's canonical
 * address, never the filters changed on the page since it opened. Changing the
 * owner is the owner's or a workspace admin's call, and only for a view shared
 * with a team or the workspace; anyone else sees the item off with the reason.
 */

import React, { useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { LuEllipsis, LuLink, LuUserCog } from 'react-icons/lu';
import { updateView, type SavedViewDisplayRead } from '../../api/views';
import { useAuth } from '../../hooks/useAuth';
import { useShortcut } from '../../hooks/useShortcuts';
import { useWorkspace } from '../../hooks/useWorkspace';
import { useWorkspaceMembers } from '../../hooks/useWorkspaceMembers';
import { canManageMembers } from '../../lib/capabilities';
import { copyText } from '../../lib/copyIssue';
import { errorMessage } from '../../lib/errors';
import { absoluteUrl } from '../../lib/newIssueUrl';
import { viewPath } from '../../lib/paths';
import { viewKey, viewsKey } from '../../lib/queryKeys';
import { showErrorToast, showToast } from '../../lib/toast';
import Avatar from '../ui/avatar';
import { IconButton } from '../ui/button';
import { Menu, MenuItem } from '../ui/menu';
import ChangeOwnerDialog from './ChangeOwnerDialog';
import type { WorkspaceRole } from '../../types/Api';

/** The palette label of the command that copies the open view's address. */
export const COPY_VIEW_URL_LABEL = 'Copy view URL';

/** The full canonical address of one saved view. */
export const viewUrl = (slug: string, viewId: string): string =>
  absoluteUrl(viewPath(slug, viewId));

/** Copies a view's canonical address and confirms it with a toast. */
export const copyViewLink = (
  slug: string,
  view: SavedViewDisplayRead
): void => {
  copyText(viewUrl(slug, view.view_id), 'View link copied');
};

/** Whether the caller may change a view's owner, and why not when they may not. */
export interface OwnerChange {
  allowed: boolean;
  reason?: string;
}

/**
 * The rule the server holds for handing a view over: its owner or a workspace
 * admin, and only once it is shared with a team or the workspace.
 */
export const viewOwnerChange = (
  view: SavedViewDisplayRead,
  userId: string | undefined,
  workspaceRole: WorkspaceRole | undefined
): OwnerChange => {
  if (view.owner_id !== userId && !canManageMembers(workspaceRole)) {
    return {
      allowed: false,
      reason: 'Only the owner or a workspace admin can change it',
    };
  }
  if (view.scope === 'personal') {
    return { allowed: false, reason: 'Share the view first' };
  }
  return { allowed: true };
};

/** Re-reads the view and every list that shows its owner. */
const refreshView = (workspaceId: string, view: SavedViewDisplayRead): void => {
  invalidateQueries([
    viewKey(workspaceId, view.view_id),
    viewsKey(workspaceId, 'mine', ''),
    viewsKey(workspaceId, 'team', ''),
    viewsKey(workspaceId, 'workspace', ''),
    viewsKey(workspaceId, 'all', ''),
    ...(view.team_id === null
      ? []
      : [
          viewsKey(workspaceId, 'team', view.team_id),
          viewsKey(workspaceId, 'all', view.team_id),
        ]),
  ]);
};

/** The Copy link item of a view's menu. */
export const CopyViewLinkItem: React.FC<{
  slug: string;
  view: SavedViewDisplayRead;
}> = ({ slug, view }) => (
  <MenuItem
    onSelect={() => {
      copyViewLink(slug, view);
    }}
  >
    <LuLink aria-hidden="true" className="h-3.5 w-3.5" />
    Copy link
  </MenuItem>
);

/** The Change owner item of a view's menu, off with its reason when not allowed. */
export const ChangeViewOwnerItem: React.FC<{
  change: OwnerChange;
  onSelect: () => void;
}> = ({ change, onSelect }) => (
  <MenuItem
    disabled={!change.allowed}
    textValue="Change owner"
    onSelect={onSelect}
  >
    <LuUserCog aria-hidden="true" className="h-3.5 w-3.5" />
    <span className="flex min-w-0 flex-col">
      <span>Change owner</span>
      {change.reason !== undefined && (
        <span className="text-2xs text-text-faint">{change.reason}</span>
      )}
    </span>
  </MenuItem>
);

/** Props for ChangeViewOwnerDialog. */
export interface ChangeViewOwnerDialogProps {
  workspaceId: string;
  view: SavedViewDisplayRead;
  onClose: () => void;
}

/** Hands one view to another member through the shared owner dialog. */
export const ChangeViewOwnerDialog: React.FC<ChangeViewOwnerDialogProps> = ({
  workspaceId,
  view,
  onClose,
}) => {
  const members = useWorkspaceMembers(workspaceId);
  const submit = async (owner: string): Promise<boolean> => {
    try {
      await updateView(workspaceId, view.view_id, { owner_id: owner });
      refreshView(workspaceId, view);
      showToast('Owner changed.');
      return true;
    } catch (failure) {
      showErrorToast(errorMessage(failure, 'Could not change the owner.'));
      return false;
    }
  };
  return (
    <ChangeOwnerDialog
      ownerId={view.owner_id}
      members={members}
      description="The owner can always edit and delete this view."
      onClose={onClose}
      onSubmit={submit}
    />
  );
};

/** Props for ViewHeaderMenu. */
export interface ViewHeaderMenuProps {
  workspaceId: string;
  slug: string;
  view: SavedViewDisplayRead;
}

/**
 * The open view's owner and its actions menu in the page header, and the
 * palette's Copy view URL command while the view is open.
 */
export const ViewHeaderMenu: React.FC<ViewHeaderMenuProps> = ({
  workspaceId,
  slug,
  view,
}) => {
  const { user } = useAuth();
  const { workspace } = useWorkspace();
  const members = useWorkspaceMembers(workspaceId);
  const [changing, setChanging] = useState(false);
  const change = viewOwnerChange(view, user?.id, workspace?.role);
  const owner = members.find((member) => member.user_id === view.owner_id);
  const ownerName = owner?.display_name ?? owner?.email;

  useShortcut({
    keys: '',
    label: COPY_VIEW_URL_LABEL,
    group: 'View',
    scope: 'page',
    handler: () => {
      copyViewLink(slug, view);
    },
  });

  return (
    <>
      {ownerName !== undefined && (
        <span
          className="inline-flex"
          title={`Owner: ${ownerName}`}
          aria-label={`Owner: ${ownerName}`}
          role="img"
        >
          <Avatar name={ownerName} src={owner?.avatar_url ?? null} size="xs" />
        </span>
      )}
      <Menu
        label="View actions"
        align="end"
        trigger={(props) => (
          <IconButton {...props} label="View actions" size="sm">
            <LuEllipsis aria-hidden="true" className="h-3.5 w-3.5" />
          </IconButton>
        )}
      >
        <CopyViewLinkItem slug={slug} view={view} />
        <ChangeViewOwnerItem
          change={change}
          onSelect={() => {
            setChanging(true);
          }}
        />
      </Menu>
      {changing && (
        <ChangeViewOwnerDialog
          workspaceId={workspaceId}
          view={view}
          onClose={() => {
            setChanging(false);
          }}
        />
      )}
    </>
  );
};

export default ViewHeaderMenu;
