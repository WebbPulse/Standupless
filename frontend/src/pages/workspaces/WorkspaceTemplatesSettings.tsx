/**
 * The Templates page of workspace settings: the issue templates every team
 * offers beside its own. Any member reads them; a workspace owner or admin
 * adds, edits, reorders and deletes them. A workspace template carries only
 * workspace statuses and labels, since anything team scoped would not exist
 * in every team it reaches. Project templates follow, kept the same way.
 */

import React from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  createWorkspaceTemplate,
  deleteWorkspaceTemplate,
  listWorkspaceTemplates,
  updateWorkspaceTemplate,
} from '../../api/templates';
import { listWorkspaceLabels, listWorkspaceStatuses } from '../../api/workflow';
import ProjectTemplateEditor from '../../components/templates/ProjectTemplateEditor';
import TemplateEditor from '../../components/templates/TemplateEditor';
import { ErrorAlert } from '../../components/ui/alert';
import { SkeletonRows } from '../../components/ui/skeleton';
import SettingsNav from '../../components/workspace/SettingsNav';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canManageMembers } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import {
  workspaceLabelsKey,
  workspaceProjectTemplatesKey,
  workspaceStatusesKey,
  workspaceTemplatesKey,
} from '../../lib/queryKeys';
import type {
  LabelRead,
  StatusRead,
  TemplateCreate,
  TemplateRead,
  TemplateUpdate,
} from '../../types/Api';

/** How often the lists are re-read while the page is open. */
const POLL_MS = 30000;

/** Props for WorkspaceProjectTemplates. */
interface WorkspaceProjectTemplatesProps {
  workspaceId: string;
  canEdit: boolean;
  statuses: StatusRead[];
  labels: LabelRead[];
}

/** Lists and edits the workspace's project templates. */
const WorkspaceProjectTemplates: React.FC<WorkspaceProjectTemplatesProps> = ({
  workspaceId,
  canEdit,
  statuses,
  labels,
}) => {
  const auth = useQueryAuth();
  const keys = [workspaceProjectTemplatesKey(workspaceId)];

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listWorkspaceTemplates(workspaceId, signal, 'project'),
    {
      intervalMs: POLL_MS,
      queryKey: workspaceProjectTemplatesKey(workspaceId),
      auth,
      enabled: workspaceId !== '',
    }
  );

  const { mutate: create } = useMutationWithRefetch(
    (body: TemplateCreate) => createWorkspaceTemplate(workspaceId, body),
    keys
  );
  const { mutate: update } = useMutationWithRefetch(
    (template: TemplateRead, body: TemplateUpdate) =>
      updateWorkspaceTemplate(workspaceId, template.id, body),
    keys
  );
  const { mutate: remove } = useMutationWithRefetch(
    (template: TemplateRead) =>
      deleteWorkspaceTemplate(workspaceId, template.id),
    keys
  );

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Project templates</h2>
        <p className="text-sm text-text-muted">
          Project templates defined here are offered in the new project dialog
          of every team, with the milestones and issues they add. Only a
          workspace admin changes them here.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the project templates.')}
        />
      )}

      {isLoading || data === null ? (
        <SkeletonRows count={2} label="Loading project templates" />
      ) : (
        <ProjectTemplateEditor
          templates={data.templates}
          scope="workspace"
          canEdit={canEdit}
          options={{ statuses, labels }}
          actions={{ create, update, remove }}
        />
      )}
    </section>
  );
};

/** Lists and edits the workspace's issue templates. */
const WorkspaceTemplatesSettings: React.FC = () => {
  const auth = useQueryAuth();
  const { workspace } = useWorkspace();
  const workspaceId = workspace?.id ?? '';
  const enabled = workspaceId !== '';
  const canEdit = canManageMembers(workspace?.role);
  const keys = [workspaceTemplatesKey(workspaceId)];

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listWorkspaceTemplates(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      queryKey: workspaceTemplatesKey(workspaceId),
      auth,
      enabled,
    }
  );
  const { data: statuses } = usePolledQuery(
    ({ signal }) => listWorkspaceStatuses(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      queryKey: workspaceStatusesKey(workspaceId),
      auth,
      enabled,
    }
  );
  const { data: labels } = usePolledQuery(
    ({ signal }) => listWorkspaceLabels(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      queryKey: workspaceLabelsKey(workspaceId),
      auth,
      enabled,
    }
  );

  const { mutate: create } = useMutationWithRefetch(
    (body: TemplateCreate) => createWorkspaceTemplate(workspaceId, body),
    keys
  );
  const { mutate: update } = useMutationWithRefetch(
    (template: TemplateRead, body: TemplateUpdate) =>
      updateWorkspaceTemplate(workspaceId, template.id, body),
    keys
  );
  const { mutate: remove } = useMutationWithRefetch(
    (template: TemplateRead) =>
      deleteWorkspaceTemplate(workspaceId, template.id),
    keys
  );

  return (
    <WorkspaceShell
      title="Settings"
      toolbar={
        workspace === null ? undefined : <SettingsNav workspace={workspace} />
      }
    >
      <div className="max-w-2xl space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">Templates</h2>
          <p className="text-sm text-text-muted">
            Templates defined here are offered in every team&apos;s new issue
            dialog, beside the team&apos;s own. Only a workspace admin changes
            them here.
          </p>
        </div>

        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load the templates.')}
          />
        )}

        {isLoading || data === null ? (
          <SkeletonRows count={3} label="Loading templates" />
        ) : (
          <TemplateEditor
            templates={data.templates}
            scope="workspace"
            canEdit={canEdit}
            options={{ statuses: statuses ?? [], labels: labels ?? [] }}
            actions={{ create, update, remove }}
          />
        )}

        <div className="pt-6">
          <WorkspaceProjectTemplates
            workspaceId={workspaceId}
            canEdit={canEdit}
            statuses={statuses ?? []}
            labels={labels ?? []}
          />
        </div>
      </div>
    </WorkspaceShell>
  );
};

export default WorkspaceTemplatesSettings;
