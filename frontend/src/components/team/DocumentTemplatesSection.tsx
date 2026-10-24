/**
 * The document templates of one team: its own, which any member may add, edit
 * and delete, and the ones it inherits from its parent team and the
 * workspace, listed read only. A team admin also picks the template a new
 * document starts from and, apart from it, the one the project update
 * composer opens with; a sub-team that picks neither takes its parent's.
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
import { errorMessage } from '../../lib/errors';
import { documentTemplatesKey, templateSettingsKey } from '../../lib/queryKeys';
import type {
  TemplateCreate,
  TemplateRead,
  TemplateSettingsUpdate,
  TemplateUpdate,
} from '../../types/Api';
import TemplateEditor from '../templates/TemplateEditor';
import { ErrorAlert } from '../ui/alert';
import { SelectField } from '../ui/select';
import Spinner from '../ui/spinner';

/** Props for DocumentTemplatesSection. */
export interface DocumentTemplatesSectionProps {
  workspaceId: string;
  teamId: string;
  /** Whether the caller may keep the team's templates, as a team member. */
  canEdit: boolean;
  /** Whether the caller may choose the defaults, as a team admin. */
  canSetDefault: boolean;
}

/** Props for DefaultSelect. */
interface DefaultSelectProps {
  label: string;
  templates: TemplateRead[];
  stored: string | null;
  effective: string | null;
  disabled: boolean;
  onPick: (templateId: string | null) => void;
}

/** How often the list is re-read while the settings page is open. */
const POLL_MS = 30000;

/** One default picker, naming the parent's choice when the team keeps none. */
const DefaultSelect: React.FC<DefaultSelectProps> = ({
  label,
  templates,
  stored,
  effective,
  disabled,
  onPick,
}) => {
  const id = useId();
  const fallback =
    stored === null && effective !== null
      ? templates.find((template) => template.id === effective)
      : undefined;
  return (
    <SelectField
      id={id}
      label={label}
      className="max-w-xs"
      disabled={disabled}
      value={stored ?? ''}
      onChange={(event) => {
        const picked = event.target.value;
        onPick(picked === '' ? null : picked);
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
  );
};

/** Lists and edits a team's document templates and its two defaults. */
export const DocumentTemplatesSection: React.FC<
  DocumentTemplatesSectionProps
> = ({ workspaceId, teamId, canEdit, canSetDefault }) => {
  const auth = useQueryAuth();
  const keys = [documentTemplatesKey(teamId), templateSettingsKey(teamId)];

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listTeamTemplates(workspaceId, teamId, signal, 'document'),
    { intervalMs: POLL_MS, queryKey: documentTemplatesKey(teamId), auth }
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
    (body: TemplateSettingsUpdate) =>
      updateTemplateSettings(workspaceId, teamId, body),
    keys
  );

  const templates = data?.templates ?? [];
  const disabled = !canSetDefault || savingDefault;

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Document templates</h3>
        <p className="text-sm text-text-muted">
          Document templates start a new document or project update with a title
          and body already in place. Templates marked Workspace or Parent team
          are kept where they are defined.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(
            error,
            'Could not load the document templates.'
          )}
        />
      )}

      {isLoading || data === null ? (
        <Spinner label="Loading document templates" />
      ) : (
        <>
          <div className="flex flex-wrap gap-4">
            <DefaultSelect
              label="Default document template"
              templates={templates}
              stored={settings?.default_document_template_id ?? null}
              effective={
                settings?.effective_default_document_template_id ?? null
              }
              disabled={disabled}
              onPick={(templateId) => {
                setDefault({ default_document_template_id: templateId }).catch(
                  () => undefined
                );
              }}
            />
            <DefaultSelect
              label="Default update template"
              templates={templates.filter(
                (template) => (template.body ?? '').trim() !== ''
              )}
              stored={settings?.default_update_template_id ?? null}
              effective={settings?.effective_default_update_template_id ?? null}
              disabled={disabled}
              onPick={(templateId) => {
                setDefault({ default_update_template_id: templateId }).catch(
                  () => undefined
                );
              }}
            />
          </div>
          {defaultError !== null && (
            <ErrorAlert
              message={errorMessage(
                defaultError,
                'Could not change the default document template.'
              )}
            />
          )}
          <TemplateEditor
            kind="document"
            templates={templates}
            scope="team"
            canEdit={canEdit}
            defaultTemplateId={data.default_template_id ?? null}
            options={{ statuses: [], labels: [] }}
            actions={{ create, update, remove }}
          />
        </>
      )}
    </section>
  );
};

export default DocumentTemplatesSection;
