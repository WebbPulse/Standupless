/**
 * Lets sidebar items take a drop of issues dragged out of a list or board, as
 * Linear's sidebar does. A team moves them there through the same path as
 * Move to team, asking first when the move would remap a status or drop a
 * label, and a favorited project or cycle sets that property on each issue.
 * A valid target highlights while hovered; any other item refuses the drag.
 * Each drop is one notice with Undo and one undo entry. Dragging is only a
 * shortcut: Move to team, the project picker and the cycle picker do the same.
 */

import React, { useCallback, useEffect, useState } from 'react';
import type { QueryKey } from '@webbpulse/api-client/react';
import type { OrderedIssueRead } from '../api/issues';
import { getProject } from '../api/planning';
import { listLabels, listStatuses } from '../api/teams';
import Button from '../components/ui/button';
import Dialog from '../components/ui/dialog';
import { moveIssues, skippedNotice } from '../lib/bulkIssueActions';
import { errorMessage } from '../lib/errors';
import {
  activeIssueDrag,
  carriesIssues,
  endIssueDrag,
  type IssueDragSource,
} from '../lib/issueDrag';
import {
  dropTargetKey,
  landPropertyDrop,
  planPropertyDrop,
  planTeamDrop,
  remapSentence,
  remapsAnything,
  teamMoveTitle,
  takesTeamDrop,
  teamRemap,
  type SidebarDropTarget,
  type TeamRemap,
} from '../lib/sidebarIssueDrop';
import { showErrorToast, showToast } from '../lib/toast';
import type { TeamRead, WorkspaceRole } from '../types/Api';

/** The drag handlers one sidebar item composes with its own. */
export interface IssueDropHandlers {
  /** Whether issues are being dragged over this item and it takes them. */
  over: boolean;
  /**
   * Takes a dragenter or dragover, answering true when it carries issues, so
   * the item's own reordering leaves it alone.
   */
  onDragOver: (event: React.DragEvent) => boolean;
  onDragLeave: (event: React.DragEvent) => void;
  /** Lands a drop of issues, answering true when it was one. */
  onDrop: (event: React.DragEvent) => boolean;
}

/** A team move waiting on the question it asks before it remaps. */
interface PendingMove {
  team: TeamRead;
  moving: OrderedIssueRead[];
  /** What it remaps, or null when the team's lists could not be read. */
  remap: TeamRemap | null;
  queryKey: QueryKey | undefined;
}

/** What {@link useSidebarIssueDrop} hands back. */
export interface SidebarIssueDrop {
  /** The handlers for one item, or for an item that takes no drop when null. */
  handlersFor: (target: SidebarDropTarget | null) => IssueDropHandlers;
  /** The question a remapping team move asks, rendered by the caller. */
  dialog: React.ReactNode;
}

/** Runs a team move through the Move to team path and refreshes the source view. */
const runTeamMove = async (
  workspaceId: string,
  pending: PendingMove
): Promise<void> => {
  const invalidate = pending.queryKey === undefined ? [] : [pending.queryKey];
  await moveIssues(workspaceId, pending.moving, pending.team, { invalidate });
};

/** The sidebar's drop handling for dragged issues. */
export const useSidebarIssueDrop = (
  workspaceId: string,
  workspaceRole: WorkspaceRole | undefined
): SidebarIssueDrop => {
  const [overKey, setOverKey] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const clear = (): void => {
      setOverKey(null);
    };
    const end = (): void => {
      endIssueDrag();
      setOverKey(null);
    };
    document.addEventListener('dragend', end);
    document.addEventListener('drop', clear);
    return () => {
      document.removeEventListener('dragend', end);
      document.removeEventListener('drop', clear);
    };
  }, []);

  const dropOnTeam = useCallback(
    async (source: IssueDragSource, team: TeamRead): Promise<void> => {
      const { moving, locked } = planTeamDrop(source, team);
      if (moving.length === 0) {
        showToast(
          locked > 0
            ? `Nothing moved. ${skippedNotice({ locked })}`
            : `Already in ${team.name}.`,
          'info'
        );
        return;
      }
      const remap = await Promise.all([
        listStatuses(workspaceId, team.id),
        listLabels(workspaceId, team.id),
      ]).then(
        ([statuses, labels]) => teamRemap(moving, statuses, labels),
        () => null
      );
      const move: PendingMove = {
        team,
        moving,
        remap,
        queryKey: source.queryKey,
      };
      if (remap !== null && !remapsAnything(remap)) {
        await runTeamMove(workspaceId, move);
        return;
      }
      setPending(move);
    },
    [workspaceId]
  );

  const dropOnProject = useCallback(
    async (
      source: IssueDragSource,
      projectId: string,
      name: string
    ): Promise<void> => {
      try {
        const project = await getProject(workspaceId, projectId);
        const plan = planPropertyDrop(
          source,
          (issue) => project.team_ids.includes(issue.team_id),
          (issue) => issue.project_id === projectId
        );
        landPropertyDrop(source, plan, project.name || name, {
          project_id: projectId,
        });
      } catch (cause) {
        showErrorToast(errorMessage(cause, `Could not move to ${name}.`));
      }
    },
    [workspaceId]
  );

  const land = useCallback(
    (target: SidebarDropTarget, source: IssueDragSource): void => {
      switch (target.kind) {
        case 'team':
          void dropOnTeam(source, target.team);
          return;
        case 'project':
          void dropOnProject(source, target.projectId, target.name);
          return;
        case 'cycle': {
          const plan = planPropertyDrop(
            source,
            (issue) => issue.team_id === target.teamId,
            (issue) => issue.cycle_id === target.cycleId
          );
          landPropertyDrop(source, plan, target.name, {
            cycle_id: target.cycleId,
          });
          return;
        }
      }
    },
    [dropOnTeam, dropOnProject]
  );

  const handlersFor = (target: SidebarDropTarget | null): IssueDropHandlers => {
    const takes =
      target !== null &&
      (target.kind !== 'team' || takesTeamDrop(target.team, workspaceRole));
    const key = target === null ? null : dropTargetKey(target);
    return {
      over: takes && key !== null && overKey === key,
      onDragOver: (event) => {
        if (!carriesIssues(event.dataTransfer)) return false;
        if (!takes) {
          if (event.dataTransfer !== null) {
            event.dataTransfer.dropEffect = 'none';
          }
          return true;
        }
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';
        if (overKey !== key) setOverKey(key);
        return true;
      },
      onDragLeave: (event) => {
        const into = event.relatedTarget;
        if (into instanceof Node && event.currentTarget.contains(into)) return;
        setOverKey((current) => (current === key ? null : current));
      },
      onDrop: (event) => {
        if (!carriesIssues(event.dataTransfer)) return false;
        event.preventDefault();
        event.stopPropagation();
        setOverKey(null);
        const source = activeIssueDrag();
        if (target !== null && takes && source !== null) land(target, source);
        return true;
      },
    };
  };

  const close = (): void => {
    if (!busy) setPending(null);
  };

  const dialog =
    pending === null ? null : (
      <Dialog
        open
        onClose={close}
        title={teamMoveTitle(pending.moving, pending.team)}
        size="sm"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            setBusy(true);
            void runTeamMove(workspaceId, pending).finally(() => {
              setBusy(false);
              setPending(null);
            });
          }}
          className="space-y-4"
        >
          <p className="text-sm break-words text-text-muted">
            {pending.remap === null
              ? `Statuses and labels ${pending.team.name} does not have are mapped to its closest status or removed.`
              : remapSentence(pending.remap, pending.team.name)}
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={busy}
              autoFocus
            >
              {busy ? 'Moving' : 'Move'}
            </Button>
          </div>
        </form>
      </Dialog>
    );

  return { handlersFor, dialog };
};
