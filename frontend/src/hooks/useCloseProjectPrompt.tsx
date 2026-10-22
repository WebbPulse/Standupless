/**
 * Wires the open issue question into a project status change. A change to
 * completed or canceled on a project with open issues opens the dialog and
 * sends the status with the chosen `open_issues`; any other change, or a close
 * with nothing open, is sent straight away as before. The dialog is portalled
 * to the body so a list row can host it without clipping it.
 */

import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import CloseProjectDialog, {
  type ClosingStatus,
} from '../components/planning/CloseProjectDialog';
import { showToast } from '../lib/toast';
import type {
  ProjectOpenIssues,
  ProjectRead,
  ProjectStatus,
  ProjectUpdate,
} from '../types/Api';
import { useWorkspaceProjects } from './useWorkspaceProjects';

const CLOSED: ReadonlySet<ProjectStatus> = new Set(['completed', 'canceled']);

/** The issues still open in a project by its rollup: todo plus in progress. */
export const openIssueCount = (project: ProjectRead): number =>
  project.counts.todo + project.counts.in_progress;

/** Whether moving a project to `status` closes it with issues still open. */
export const asksAboutOpenIssues = (
  project: ProjectRead,
  status: ProjectStatus
): status is ClosingStatus =>
  CLOSED.has(status) &&
  status !== project.status &&
  openIssueCount(project) > 0;

/**
 * The projects a closing project's open issues may move to: open, not the
 * project itself, and on every team the project is on, so each issue's team
 * holds the target.
 */
export const moveTargets = (
  project: ProjectRead,
  projects: ProjectRead[]
): ProjectRead[] =>
  projects
    .filter(
      (candidate) =>
        candidate.project_id !== project.project_id &&
        !CLOSED.has(candidate.status) &&
        project.team_ids.every((teamId) => candidate.team_ids.includes(teamId))
    )
    .sort((left, right) => left.name.localeCompare(right.name));

/** Props for useCloseProjectPrompt: the project and how to patch it. */
export interface CloseProjectPromptOptions {
  workspaceId: string;
  project: ProjectRead | null;
  update: (patch: ProjectUpdate) => Promise<boolean>;
}

/** What useCloseProjectPrompt answers: the status handler and the dialog to render. */
export interface CloseProjectPrompt {
  changeStatus: (status: ProjectStatus) => void;
  dialog: React.ReactNode;
}

/** A status change handler that asks about open issues before a close. */
export const useCloseProjectPrompt = ({
  workspaceId,
  project,
  update,
}: CloseProjectPromptOptions): CloseProjectPrompt => {
  const [closing, setClosing] = useState<ClosingStatus | null>(null);
  const { projects } = useWorkspaceProjects(workspaceId, '', closing !== null);
  const targets = useMemo(
    () => (project === null ? [] : moveTargets(project, projects)),
    [project, projects]
  );

  const changeStatus = (status: ProjectStatus) => {
    if (project !== null && asksAboutOpenIssues(project, status)) {
      setClosing(status);
      return;
    }
    void update({ status });
  };

  const confirm = (choice: ProjectOpenIssues) => {
    if (project === null || closing === null) return;
    const count = openIssueCount(project);
    const noun = count === 1 ? 'issue' : 'issues';
    const target = targets.find((row) => row.project_id === choice.project_id);
    setClosing(null);
    void update({ status: closing, open_issues: choice }).then((done) => {
      if (!done) return;
      if (choice.action === 'move' && target !== undefined) {
        showToast(`Moved ${String(count)} ${noun} to ${target.name}`);
      } else if (choice.action === 'cancel') {
        showToast(`Canceled ${String(count)} ${noun}`);
      }
    });
  };

  const dialog =
    project !== null && closing !== null
      ? createPortal(
          <CloseProjectDialog
            project={project}
            status={closing}
            openIssues={openIssueCount(project)}
            targets={targets}
            onConfirm={confirm}
            onClose={() => {
              setClosing(null);
            }}
          />,
          document.body
        )
      : null;

  return { changeStatus, dialog };
};

export default useCloseProjectPrompt;
