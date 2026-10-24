/**
 * Adds and removes project dependencies from the timeline. A change draws at
 * once as a pending link, writes the relation from the side the viewer may
 * edit, and refreshes the list and both projects. A refused link, such as a
 * self link or one that would make two projects wait on each other, is
 * undone with the server's reason. A pending link that has been written is
 * dropped once the project list the timeline draws moves on, since the fresh
 * read then holds the stored answer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invalidateQueries, type QueryKey } from '@webbpulse/api-client/react';
import {
  createProjectRelation,
  deleteProjectRelation,
  listProjectRelations,
} from '../api/planning';
import { errorMessage } from '../lib/errors';
import { linkKey, type PendingLink } from '../lib/projectDependencies';
import { projectDetailKey, projectsKey } from '../lib/queryKeys';
import { showErrorToast } from '../lib/toast';
import type { ProjectRead } from '../types/Api';

/** What {@link useTimelineLinks} hands back. */
export interface TimelineLinks {
  pending: PendingLink[];
  /**
   * Makes `blockerId` block `blockedId`, writing from `pathId`'s side, which
   * must be one of the two and a project the viewer may edit.
   */
  link: (pathId: string, blockerId: string, blockedId: string) => void;
  /** Removes `blockerId` blocking `blockedId`, writing from `pathId`'s side. */
  unlink: (pathId: string, blockerId: string, blockedId: string) => void;
}

/** One pending link and, once its write lands, the list it landed over. */
interface Held {
  link: PendingLink;
  settledOver: readonly ProjectRead[] | null;
}

/** The timeline's dependency writes and the links still waiting on them. */
export const useTimelineLinks = (
  workspaceId: string,
  projects: readonly ProjectRead[],
  refreshKey: QueryKey
): TimelineLinks => {
  const [held, setHeld] = useState<Held[]>([]);
  const current = useRef(projects);
  useEffect(() => {
    current.current = projects;
  }, [projects]);
  const pending = useMemo(
    () =>
      held
        .filter(
          (row) => row.settledOver === null || row.settledOver === projects
        )
        .map((row) => row.link),
    [held, projects]
  );

  const settle = useCallback(
    (
      link: PendingLink,
      write: Promise<unknown>,
      fallback: string,
      optimistic: boolean
    ): void => {
      const key = linkKey(link.blockerId, link.blockedId);
      if (optimistic)
        setHeld((rows) => [
          ...rows.filter(
            (row) => linkKey(row.link.blockerId, row.link.blockedId) !== key
          ),
          { link, settledOver: null },
        ]);
      write
        .then(() => {
          setHeld((rows) =>
            rows.map((row) =>
              row.link === link ? { ...row, settledOver: current.current } : row
            )
          );
          invalidateQueries(refreshKey);
          invalidateQueries(projectsKey(workspaceId, '', ''));
          invalidateQueries(projectDetailKey(workspaceId, link.blockerId));
          invalidateQueries(projectDetailKey(workspaceId, link.blockedId));
        })
        .catch((failure: unknown) => {
          setHeld((rows) => rows.filter((row) => row.link !== link));
          showErrorToast(errorMessage(failure, fallback));
        });
    },
    [refreshKey, workspaceId]
  );

  const link = useCallback(
    (pathId: string, blockerId: string, blockedId: string): void => {
      const other = pathId === blockerId ? blockedId : blockerId;
      const write = createProjectRelation(workspaceId, pathId, {
        type: pathId === blockerId ? 'blocks' : 'blocked_by',
        target_project_id: other,
      });
      settle(
        { blockerId, blockedId, removing: false },
        write,
        'Could not link those projects.',
        blockerId !== blockedId
      );
    },
    [settle, workspaceId]
  );

  const unlink = useCallback(
    (pathId: string, blockerId: string, blockedId: string): void => {
      const type = pathId === blockerId ? 'blocks' : 'blocked_by';
      const other = pathId === blockerId ? blockedId : blockerId;
      const write = async (): Promise<void> => {
        const relations = await listProjectRelations(workspaceId, pathId);
        const relation = relations.find(
          (row) => row.type === type && row.target_project_id === other
        );
        if (relation !== undefined)
          await deleteProjectRelation(
            workspaceId,
            pathId,
            relation.relation_id
          );
      };
      settle(
        { blockerId, blockedId, removing: true },
        write(),
        'Could not remove that dependency.',
        true
      );
    },
    [settle, workspaceId]
  );

  return { pending, link, unlink };
};

export default useTimelineLinks;
