/**
 * Moves and card edits made on the projects board, shown before the polled
 * read catches up.
 * A move lays its change over the project at once, so the card lands in its
 * new column the moment it is dropped; the stored project replaces it when
 * the write answers, and a newer read replaces that. A failed write takes the
 * move back and says so in a notice.
 */

import { useCallback, useState } from 'react';
import { invalidateQueries, type QueryKey } from '@webbpulse/api-client/react';
import { updateProject } from '../api/planning';
import { errorMessage } from '../lib/errors';
import type { ProjectMove } from '../lib/projectList';
import { showErrorToast } from '../lib/toast';
import type { ProjectOpenIssues, ProjectRead } from '../types/Api';

/** What useProjectMoves answers: the overlay and the move. */
export interface ProjectMoves {
  /** The projects with every move still ahead of the read laid over them. */
  apply: (projects: ProjectRead[]) => ProjectRead[];
  /** Moves one project, with the open issue choice when the move closes it. */
  move: (
    project: ProjectRead,
    change: ProjectMove,
    openIssues?: ProjectOpenIssues
  ) => void;
}

/** Holds the board's moves over the polled projects. */
export const useProjectMoves = (
  workspaceId: string,
  refreshKey: QueryKey
): ProjectMoves => {
  const [held, setHeld] = useState<Record<string, ProjectRead>>({});

  const apply = useCallback(
    (projects: ProjectRead[]): ProjectRead[] =>
      projects.map((project) => {
        const moved = held[project.project_id];
        return moved !== undefined && moved.updated_at >= project.updated_at
          ? moved
          : project;
      }),
    [held]
  );

  const forget = useCallback((projectId: string): void => {
    setHeld((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => key !== projectId)
      )
    );
  }, []);

  const move = useCallback(
    (
      project: ProjectRead,
      change: ProjectMove,
      openIssues?: ProjectOpenIssues
    ): void => {
      const projectId = project.project_id;
      setHeld((current) => ({
        ...current,
        [projectId]: { ...project, ...change },
      }));
      void updateProject(
        workspaceId,
        projectId,
        openIssues === undefined
          ? change
          : { ...change, open_issues: openIssues }
      )
        .then((stored) => {
          setHeld((current) => ({ ...current, [projectId]: stored }));
          invalidateQueries(refreshKey);
        })
        .catch((failure: unknown) => {
          forget(projectId);
          showErrorToast(
            errorMessage(
              failure,
              'Could not update that project. It has been undone.'
            )
          );
        });
    },
    [workspaceId, refreshKey, forget]
  );

  return { apply, move };
};

export default useProjectMoves;
