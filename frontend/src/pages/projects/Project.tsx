/**
 * One project, resolved from the `:keyPrefix` in the route. Holds the issues
 * tab, which is a placeholder until M2, and the settings tab carrying statuses,
 * labels and project members.
 */

import React, { useState } from 'react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { useParams } from 'react-router-dom';
import { listProjects } from '../../api/projects';
import LabelsSection from '../../components/project/LabelsSection';
import ProjectMembersSection from '../../components/project/ProjectMembersSection';
import StatusesSection from '../../components/project/StatusesSection';
import { ErrorAlert } from '../../components/ui/alert';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useQueryAuth } from '../../hooks/useQueryAuth';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canManageMembers, isProjectAdmin } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { projectsKey } from '../../lib/queryKeys';

/** How often the project list is re-read while this page is open. */
const POLL_MS = 60000;

/** Which tab of the project page is showing. */
type Tab = 'issues' | 'settings';

const tabClass = (active: boolean): string =>
  active
    ? 'border-b-2 border-sky-400 pb-1 text-sm text-white'
    : 'border-b-2 border-transparent pb-1 text-sm text-slate-400 hover:text-slate-200';

/**
 * Resolves the key prefix to a project through the workspace's project list,
 * which the contract makes the only route that can answer it, then renders the
 * tab that is showing.
 */
const Project: React.FC = () => {
  const { keyPrefix } = useParams<{ keyPrefix: string }>();
  const { workspace } = useWorkspace();
  const auth = useQueryAuth();
  const [tab, setTab] = useState<Tab>('issues');

  const workspaceId = workspace?.id ?? '';

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listProjects(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '',
      queryKey: projectsKey(workspaceId),
      ...(auth === undefined ? {} : { auth }),
    }
  );

  const project =
    data === null || keyPrefix === undefined
      ? null
      : (data.find((item) => item.key_prefix === keyPrefix) ?? null);

  const editable = isProjectAdmin(workspace?.role, project?.role);

  return (
    <WorkspaceShell>
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load this project.')}
        />
      )}

      {isLoading || data === null ? (
        <Spinner label="Loading project" />
      ) : project === null ? (
        <section className="space-y-2">
          <h2 className="text-lg font-medium text-white">Project not found</h2>
          <p className="text-sm text-slate-400">
            No project in this workspace uses that key, or you do not have
            access to it.
          </p>
        </section>
      ) : (
        <div className="space-y-6">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-lg font-medium text-white">{project.name}</h2>
            <span className="text-xs text-slate-500">{project.key_prefix}</span>
          </div>

          <nav className="flex gap-6">
            <button
              type="button"
              className={tabClass(tab === 'issues')}
              onClick={() => {
                setTab('issues');
              }}
            >
              Issues
            </button>
            <button
              type="button"
              className={tabClass(tab === 'settings')}
              onClick={() => {
                setTab('settings');
              }}
            >
              Settings
            </button>
          </nav>

          {tab === 'issues' ? (
            <section className="rounded-md border border-dashed border-slate-700 px-4 py-8 text-center">
              <p className="text-sm text-slate-400">
                Issues arrive in the next milestone. Statuses and labels for
                this project can be set up on the settings tab now.
              </p>
            </section>
          ) : (
            <div className="space-y-8">
              <StatusesSection
                workspaceId={workspaceId}
                projectId={project.id}
                canEdit={editable}
              />
              <LabelsSection
                workspaceId={workspaceId}
                projectId={project.id}
                canEdit={editable}
              />
              <ProjectMembersSection
                workspaceId={workspaceId}
                projectId={project.id}
                canEdit={editable}
                canReadWorkspaceMembers={canManageMembers(workspace?.role)}
              />
            </div>
          )}
        </div>
      )}
    </WorkspaceShell>
  );
};

export default Project;
