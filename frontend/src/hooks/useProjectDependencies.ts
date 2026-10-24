/**
 * Links and unlinks one project's dependencies from its page. The project
 * read carries the linked ids on each side, so the picker shows them without
 * another call; a toggle shows at once, writes the relation, and refreshes the
 * project, the list and the project at the other end. A refused link, such as
 * one that would make two projects wait on each other, is undone with the
 * server's reason.
 */

import { useCallback, useMemo, useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import {
  createProjectRelation,
  deleteProjectRelation,
  listProjectRelations,
} from '../api/planning';
import { errorMessage } from '../lib/errors';
import { projectDetailKey, projectsKey } from '../lib/queryKeys';
import { showErrorToast } from '../lib/toast';
import type { ProjectRead, ProjectRelationType } from '../types/Api';

/** The ids linked on each side, as the page shows them. */
export interface ProjectDependencySides {
  blocked_by: string[];
  blocks: string[];
}

/** What {@link useProjectDependencies} hands back. */
export interface ProjectDependencies {
  sides: ProjectDependencySides;
  /** Links the project on that side, or unlinks it when it is already linked. */
  toggle: (type: ProjectRelationType, targetId: string) => void;
}

/** A local change and the server sides it was made over, dropped once the server moves on. */
interface Held {
  base: ProjectDependencySides;
  sides: ProjectDependencySides;
}

/** One side with a project added or taken off. */
const flip = (ids: string[], targetId: string): string[] =>
  ids.includes(targetId)
    ? ids.filter((id) => id !== targetId)
    : [...ids, targetId];

/** One project's dependencies and the toggle that edits them. */
export const useProjectDependencies = (
  workspaceId: string,
  project: ProjectRead | null
): ProjectDependencies => {
  const blockedBy = project?.blocked_by_project_ids;
  const blocking = project?.blocking_project_ids;
  const server = useMemo<ProjectDependencySides>(
    () => ({ blocked_by: blockedBy ?? [], blocks: blocking ?? [] }),
    [blockedBy, blocking]
  );
  const [held, setHeld] = useState<Held | null>(null);
  const sides = held !== null && held.base === server ? held.sides : server;

  const projectId = project?.project_id ?? '';
  const toggle = useCallback(
    (type: ProjectRelationType, targetId: string): void => {
      if (projectId === '') return;
      const linked = sides[type].includes(targetId);
      const before = held;
      setHeld({
        base: server,
        sides: { ...sides, [type]: flip(sides[type], targetId) },
      });
      const write = async (): Promise<void> => {
        if (!linked) {
          await createProjectRelation(workspaceId, projectId, {
            type,
            target_project_id: targetId,
          });
          return;
        }
        const relations = await listProjectRelations(workspaceId, projectId);
        const relation = relations.find(
          (row) => row.type === type && row.target_project_id === targetId
        );
        if (relation !== undefined)
          await deleteProjectRelation(
            workspaceId,
            projectId,
            relation.relation_id
          );
      };
      write()
        .then(() => {
          invalidateQueries(projectDetailKey(workspaceId, projectId));
          invalidateQueries(projectDetailKey(workspaceId, targetId));
          invalidateQueries(projectsKey(workspaceId, '', ''));
        })
        .catch((failure: unknown) => {
          setHeld(before);
          showErrorToast(
            errorMessage(failure, 'Could not change that dependency.')
          );
        });
    },
    [projectId, sides, held, server, workspaceId]
  );

  return { sides, toggle };
};

export default useProjectDependencies;
