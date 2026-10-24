/**
 * The project templates of one team: its own, which any member may add, edit,
 * reorder and delete, and the ones it inherits from its parent team and the
 * workspace, listed read only. A team admin also picks the template the new
 * project dialog opens with for the team; a sub-team that picks none opens
 * with its parent's.
 */

import React, { useId } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  createTeamTemplate,
  deleteTeamTemplate,
  getTemplateSettings,
  listTeamTemplates,
  updateTeamTemplate,
  updateTemplateSettings,
} from '../../api/templates';
import { useTeamOptions } from '../../hooks/useTeamOptions';
import { errorMessage } from '../../lib/errors';
import { projectTemplatesKey, templateSettingsKey } from '../../lib/queryKeys';
import type { EstimateOptions } from '../../lib/validation';
import type {
  EstimateScale,
  TemplateCreate,
  TemplateRead,
  TemplateUpdate,
} from '../../types/Api';
import ProjectTemplateEditor from '../templates/ProjectTemplateEditor';
import { ErrorAlert } from '../ui/alert';
import { SelectField } from '../ui/select';
import Spinner from '../ui/spinner';

/** Props for ProjectTemplatesSection. */
export interface ProjectTemplatesSectionProps {
  workspaceId: string;
  teamId: string;
  estimateScale: EstimateScale;
  estimateOptions?: EstimateOptions;
  /** Whether the caller may keep the team's templates, as a team member. */
  canEdit: boolean;
  /** Whether the caller may choose the default, as a team admin. */
  canSetDefault: boolean;
}

/** How often the list is re-read while the settings page is open. */
const POLL_MS = 30000;

/** Lists and edits a team's project templates and its default. */
export const ProjectTemplatesSection: React.FC<
  ProjectTemplatesSectionProps
> = ({
  workspaceId,
  teamId,
  estimateScale,
  estimateOptions,
  canEdit,
  canSetDefault,
}) => {
  const auth = useQueryAuth();
  const selectId = useId();
  const keys = [projectTemplatesKey(teamId), templateSettingsKey(teamId)];
  const options = useTeamOptions(workspaceId, teamId, { planning: true });

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listTeamTemplates(workspaceId, teamId, signal, 'project'),
    { intervalMs: POLL_MS, queryKey: projectTemplatesKey(teamId), auth }
  );
  const { data: settings } = usePolledQuery(
    ({ signal }) => getTemplateSettings(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, queryKey: templateSettingsKey(teamId), auth }
  );

  const { mutate: create } = useMutationWithRefetch(
    (body: TemplateCreate) => createTeamTemplate(workspaceId, teamId, body),
    keys
  );
  const { mutate: update } = useMutationWithRefetch(
    (template: TemplateRead, body: TemplateUpdate) =>
      updateTeamTemplate(workspaceId, teamId, template.id, body),
    keys
  );
  const { mutate: remove } = useMutationWithRefetch(
    (template: TemplateRead) =>
      deleteTeamTemplate(workspaceId, teamId, template.id),
    keys
  );
  const {
    mutate: setDefault,
    isMutating: savingDefault,
    error: defaultError,
  } = useMutationWithRefetch(
    (templateId: string | null) =>
      updateTemplateSettings(workspaceId, teamId, {
        default_project_template_id: templateId,
      }),
    keys
  );

  const templates = data?.templates ?? [];
  const effective = data?.default_template_id ?? null;
  const stored = settings?.default_project_template_id ?? null;
  const fallback =
    stored === null && effective !== null
      ? templates.find((template) => template.id === effective)
      : undefined;

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Project templates</h3>
        <p className="text-sm text-text-muted">
          Project templates prefill the new project dialog and add milestones
          and issues to the project it creates. Templates marked Workspace or
          Parent team are kept where they are defined.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the project templates.')}
        />
      )}

      {isLoading || data === null ? (
        <Spinner label="Loading project templates" />
      ) : (
        <>
          <SelectField
            id={selectId}
            label="Default project template"
            className="max-w-xs"
            disabled={!canSetDefault || savingDefault}
            value={stored ?? ''}
            onChange={(event) => {
              const picked = event.target.value;
              setDefault(picked === '' ? null : picked).catch(() => undefined);
            }}
          >
            <option value="">
              {fallback === undefined
                ? 'No default'
                : `Parent team default (${fallback.name})`}
            </option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </SelectField>
          {defaultError !== null && (
            <ErrorAlert
              message={errorMessage(
                defaultError,
                'Could not change the default project template.'
              )}
            />
          )}
          <ProjectTemplateEditor
            templates={templates}
            scope="team"
            canEdit={canEdit}
            defaultTemplateId={effective}
            options={{
              statuses: options.statuses,
              labels: options.labels,
              people: options.people,
              estimateScale,
              ...(estimateOptions === undefined ? {} : { estimateOptions }),
            }}
            actions={{ create, update, remove }}
          />
        </>
      )}
    </section>
  );
};

export default ProjectTemplatesSection;
