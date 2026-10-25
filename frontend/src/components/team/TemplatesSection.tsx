/**
 * The issue templates of one team: its own, which any member may add, edit,
 * reorder and delete, and the ones it inherits from its parent team and the
 * workspace, listed read only. A team admin also picks the template the
 * team's create dialog opens with; a sub-team that picks none opens with its
 * parent's. A second default covers people outside the team, so requests
 * filed by other teams open in a request shape; left unset, they open with the
 * members' default. The team's project and document templates follow, kept the
 * same way. Each issue template's row can copy a link that opens the create
 * dialog with that template applied.
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
import { absoluteUrl, newIssuePath } from '../../lib/newIssueUrl';
import { templateSettingsKey, templatesKey } from '../../lib/queryKeys';
import { showErrorToast, showToast } from '../../lib/toast';
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
import DocumentTemplatesSection from './DocumentTemplatesSection';
import ProjectTemplatesSection from './ProjectTemplatesSection';

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
  /** Opens a recurring schedule for a template, from its row. */
  onMakeRecurring?: (template: TemplateRead) => void;
  /** The workspace slug and team key that copied create links point at. */
  slug?: string;
  teamKey?: string;
}

/** How often the list is re-read while the settings page is open. */
const POLL_MS = 30000;

/** Lists and edits a team's templates and its default. */
export const TemplatesSection: React.FC<TemplatesSectionProps> = ({
  workspaceId,
  teamId,
  estimateScale,
  estimateOptions,
  canEdit,
  canSetDefault,
  onMakeRecurring,
  slug,
  teamKey,
}) => {
  const auth = useQueryAuth();
  const selectId = useId();
  const nonMemberSelectId = useId();
  const keys = [templatesKey(teamId), templateSettingsKey(teamId)];
  const options = useTeamOptions(workspaceId, teamId, { planning: true });

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listTeamTemplates(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, queryKey: templatesKey(teamId), auth }
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
        default_template_id: templateId,
      }),
    keys
  );

  const {
    mutate: setNonMemberDefault,
    isMutating: savingNonMemberDefault,
    error: nonMemberDefaultError,
  } = useMutationWithRefetch(
    (templateId: string | null) =>
      updateTemplateSettings(workspaceId, teamId, {
        non_member_default_template_id: templateId,
      }),
    keys
  );

  const copyCreateUrl =
    slug === undefined
      ? undefined
      : (template: TemplateRead): void => {
          globalThis.navigator.clipboard
            .writeText(
              absoluteUrl(
                newIssuePath(slug, { template: template.id }, teamKey)
              )
            )
            .then(
              () => {
                showToast('Copied URL to create issue from template');
              },
              () => {
                showErrorToast('Could not copy the template URL.');
              }
            );
        };

  const templates = data?.templates ?? [];
  const effective = data?.default_template_id ?? null;
  const stored = settings?.default_template_id ?? null;
  const fallback =
    stored === null && effective !== null
      ? templates.find((template) => template.id === effective)
      : undefined;
  const storedNonMember = settings?.non_member_default_template_id ?? null;
  const membersDefault =
    effective === null
      ? undefined
      : templates.find((template) => template.id === effective);

  return (
    <div className="space-y-8">
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
                const next = picked === '' ? null : picked;
                setDefault(next).catch(() => undefined);
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
            <SelectField
              id={nonMemberSelectId}
              label="Default template for non-members"
              className="max-w-xs"
              disabled={!canSetDefault || savingNonMemberDefault}
              value={storedNonMember ?? ''}
              onChange={(event) => {
                const picked = event.target.value;
                const next = picked === '' ? null : picked;
                setNonMemberDefault(next).catch(() => undefined);
              }}
            >
              <option value="">
                {membersDefault === undefined
                  ? 'Same as members (no default)'
                  : `Same as members (${membersDefault.name})`}
              </option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </SelectField>
            {nonMemberDefaultError !== null && (
              <ErrorAlert
                message={errorMessage(
                  nonMemberDefaultError,
                  'Could not change the default template for non-members.'
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
              {...(onMakeRecurring === undefined ? {} : { onMakeRecurring })}
              {...(copyCreateUrl === undefined
                ? {}
                : { onCopyCreateUrl: copyCreateUrl })}
            />
          </>
        )}
      </section>
      <ProjectTemplatesSection
        workspaceId={workspaceId}
        teamId={teamId}
        estimateScale={estimateScale}
        {...(estimateOptions === undefined ? {} : { estimateOptions })}
        canEdit={canEdit}
        canSetDefault={canSetDefault}
      />
      <DocumentTemplatesSection
        workspaceId={workspaceId}
        teamId={teamId}
        canEdit={canEdit}
        canSetDefault={canSetDefault}
      />
    </div>
  );
};

export default TemplatesSection;
