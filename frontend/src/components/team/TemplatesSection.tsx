/**
 * The issue templates of one team: its own, which any member may add, edit,
 * reorder and delete, and the ones it inherits from its parent team and the
 * workspace, listed read only. A team admin also picks the template the
 * team's create dialog opens with; a sub-team that picks none opens with its
 * parent's.
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
import { templatesKey } from '../../lib/queryKeys';
import type { EstimateOptions } from '../../lib/validation';
import type {
  EstimateScale,
  TemplateCreate,
  TemplateRead,
  TemplateUpdate,
} from '../../types/Api';
import TemplateEditor from '../templates/TemplateEditor';
import { ErrorAlert } from '../ui/alert';
import { SelectField } from '../ui/select';
import Spinner from '../ui/spinner';

/** Props for TemplatesSection: which team, and what the caller may change. */
export interface TemplatesSectionProps {
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

/** The query key the team's saved default is read under. */
const settingsKey = (teamId: string) => [...templatesKey(teamId), 'settings'];

/** Lists and edits a team's templates and its default. */
export const TemplatesSection: React.FC<TemplatesSectionProps> = ({
  workspaceId,
  teamId,
  estimateScale,
  estimateOptions,
  canEdit,
  canSetDefault,
}) => {
  const auth = useQueryAuth();
  const selectId = useId();
  const keys = [templatesKey(teamId), settingsKey(teamId)];
  const options = useTeamOptions(workspaceId, teamId, { planning: true });

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listTeamTemplates(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, queryKey: templatesKey(teamId), auth }
  );
  const { data: settings } = usePolledQuery(
    ({ signal }) => getTemplateSettings(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, queryKey: settingsKey(teamId), auth }
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
        default_template_id: templateId,
      }),
    keys
  );

  const templates = data?.templates ?? [];
  const effective = data?.default_template_id ?? null;
  const stored = settings?.default_template_id ?? null;
  const fallback =
    stored === null && effective !== null
      ? templates.find((template) => template.id === effective)
      : undefined;

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Templates</h3>
        <p className="text-sm text-text-muted">
          Templates prefill the new issue dialog with a title, description and
          properties. Templates marked Workspace or Parent team are kept where
          they are defined.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the templates.')}
        />
      )}

      {isLoading || data === null ? (
        <Spinner label="Loading templates" />
      ) : (
        <>
          <SelectField
            id={selectId}
            label="Default template"
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
                'Could not change the default template.'
              )}
            />
          )}
          <TemplateEditor
            templates={templates}
            scope="team"
            canEdit={canEdit}
            defaultTemplateId={effective}
            options={{
              statuses: options.statuses,
              labels: options.labels,
              people: options.people,
              projects: options.projects,
              cycles: options.cycles,
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

export default TemplatesSection;
