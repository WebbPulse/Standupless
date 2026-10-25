/**
 * A team's create by email addresses: one for the team, and one for any issue
 * template that should file its own kind of issue.
 *
 * Mail sent to an address files an issue in the team, in Triage when triage is
 * on, created as the admin who turned the address on and marked "via email".
 * Regenerating an address revokes the old one at once, so a leaked address is
 * one click to retire. Nothing is ever sent back to whoever mailed it.
 */

import React, { useId, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
  type QueryKey,
} from '@webbpulse/api-client/react';
import {
  disableEmailIntake,
  enableEmailIntake,
  getEmailIntake,
  regenerateEmailIntake,
} from '../../api/integrations';
import { listTeamTemplates } from '../../api/templates';
import type { EmailIntakeRead, TemplateRead } from '../../types/Api';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { showToast } from '../../lib/toast';
import { ErrorAlert } from '../ui/alert';
import { Button } from '../ui/button';
import Spinner from '../ui/spinner';

/** Props for EmailIntakeSection: which team, and whether the caller may edit. */
export interface EmailIntakeSectionProps {
  workspaceId: string;
  teamId: string;
  /** Whether the caller administers the team. */
  canEdit: boolean;
}

/** How often the addresses are re-read while the settings tab is open. */
const POLL_MS = 60000;

/** Copies text to the clipboard, answering whether it took. */
const copyText = async (text: string): Promise<boolean> => {
  try {
    await globalThis.navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

/** One change to an address the section can make. */
type IntakeChange = {
  action: 'enable' | 'regenerate' | 'disable';
  templateId: string | null;
};

/** Props for the on and off switch an address row ends in. */
interface ToggleProps {
  id: string;
  checked: boolean;
  disabled: boolean;
  labelledBy: string;
  onChange: (checked: boolean) => void;
}

/** An on and off switch, announced as a switch. */
const Toggle: React.FC<ToggleProps> = ({
  id,
  checked,
  disabled,
  labelledBy,
  onChange,
}) => (
  <button
    id={id}
    type="button"
    role="switch"
    aria-checked={checked}
    aria-labelledby={labelledBy}
    disabled={disabled}
    onClick={() => {
      onChange(!checked);
    }}
    className={cn(
      'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-transparent transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60',
      checked
        ? 'bg-accent enabled:hover:bg-accent-strong'
        : 'bg-line-strong enabled:hover:bg-text-faint',
      'enabled:active:brightness-90'
    )}
  >
    <span
      aria-hidden="true"
      className={cn(
        'inline-block h-3 w-3 rounded-full bg-bg shadow-sm transition-transform duration-100',
        checked ? 'translate-x-3' : 'translate-x-0'
      )}
    />
  </button>
);

/** Props for one address row. */
interface AddressRowProps {
  label: string;
  hint: string;
  intake: EmailIntakeRead | undefined;
  templateId: string | null;
  disabled: boolean;
  onChange: (change: IntakeChange) => void;
}

/** One address: what it files, its switch, and when on the address with copy and regenerate. */
const AddressRow: React.FC<AddressRowProps> = ({
  label,
  hint,
  intake,
  templateId,
  disabled,
  onChange,
}) => {
  const controlId = useId();
  const labelId = useId();
  const on = intake !== undefined;
  return (
    <li className="space-y-2 px-3 py-2">
      <div className="flex min-h-row items-center justify-between gap-4">
        <div className="min-w-0">
          <label
            id={labelId}
            htmlFor={controlId}
            className="block text-sm font-medium text-text"
          >
            {label}
          </label>
          <p className="text-xs text-text-muted">{hint}</p>
        </div>
        <Toggle
          id={controlId}
          labelledBy={labelId}
          checked={on}
          disabled={disabled}
          onChange={(next) => {
            onChange({ action: next ? 'enable' : 'disable', templateId });
          }}
        />
      </div>
      {intake !== undefined && (
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-sm border border-line bg-bg-subtle px-2 py-1 font-mono text-xs text-text">
            {intake.address}
          </code>
          <Button
            size="sm"
            onClick={() => {
              void copyText(intake.address).then((copied) => {
                showToast(
                  copied ? 'Address copied.' : 'Could not copy the address.'
                );
              });
            }}
          >
            Copy
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => {
              onChange({ action: 'regenerate', templateId });
            }}
          >
            Regenerate
          </Button>
        </div>
      )}
    </li>
  );
};

/** Shows and edits a team's create by email addresses. */
export const EmailIntakeSection: React.FC<EmailIntakeSectionProps> = ({
  workspaceId,
  teamId,
  canEdit,
}) => {
  const auth = useQueryAuth();
  const [confirming, setConfirming] = useState<string | null>(null);
  const queryKey: QueryKey = ['email-intake', workspaceId, teamId];
  const templatesKey: QueryKey = [
    'email-intake-templates',
    workspaceId,
    teamId,
  ];

  const { data, error, isLoading, refetch } = usePolledQuery(
    ({ signal }) => getEmailIntake(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );
  const { data: templateList } = usePolledQuery(
    ({ signal }) => listTeamTemplates(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, queryKey: templatesKey, auth }
  );

  const {
    mutate: change,
    error: saveError,
    isMutating: saving,
  } = useMutationWithRefetch(
    async ({ action, templateId }: IntakeChange) => {
      if (action === 'enable') {
        await enableEmailIntake(workspaceId, teamId, templateId);
      } else if (action === 'regenerate') {
        await regenerateEmailIntake(workspaceId, teamId, templateId);
      } else {
        await disableEmailIntake(workspaceId, teamId, templateId);
      }
    },
    [queryKey]
  );

  const MESSAGES: Record<IntakeChange['action'], string> = {
    enable: 'Create by email turned on.',
    regenerate: 'New address made. The old one no longer files issues.',
    disable: 'Create by email turned off.',
  };

  const submit = async (next: IntakeChange): Promise<void> => {
    if (!canEdit) return;
    const key = `${next.action}:${next.templateId ?? ''}`;
    if (next.action === 'regenerate' && confirming !== key) {
      setConfirming(key);
      showToast('Select Regenerate again to replace this address.');
      return;
    }
    setConfirming(null);
    try {
      await change(next);
      await refetch();
      showToast(MESSAGES[next.action]);
    } catch {
      return;
    }
  };

  const addresses = data?.addresses ?? [];
  const teamAddress = addresses.find((row) => row.template_id === null);
  const byTemplate = new Map(
    addresses
      .filter((row) => row.template_id !== null)
      .map((row) => [row.template_id, row])
  );
  const templates: TemplateRead[] = (templateList?.templates ?? []).filter(
    (row) =>
      (row.kind ?? 'issue') === 'issue' && (row.form_fields ?? []).length === 0
  );
  const available = data?.available ?? false;
  const disabled = !canEdit || saving || !available;

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Create by email</h3>
        <p className="text-sm text-text-muted">
          Forward or send mail to an address to file it as an issue. The subject
          becomes the title, the message the description, and attachments are
          kept. Issues land in Triage when it is on, and are created as the
          admin who turned the address on.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(
            error,
            'Could not load the create by email settings.'
          )}
        />
      )}
      {saveError !== null && (
        <ErrorAlert
          message={errorMessage(
            saveError,
            'Could not change the create by email address.'
          )}
        />
      )}

      {isLoading && data === null ? (
        <Spinner label="Loading the create by email settings" />
      ) : (
        <>
          {data !== null && !available && (
            <p className="text-sm text-text-muted">
              Create by email is not available in this environment.
            </p>
          )}
          <ul className="divide-y divide-line rounded-md border border-line">
            <AddressRow
              label="Team address"
              hint="Files issues in this team with its default settings."
              intake={teamAddress}
              templateId={null}
              disabled={disabled}
              onChange={(next) => {
                void submit(next);
              }}
            />
            {templates.map((template) => (
              <AddressRow
                key={template.id}
                label={template.name}
                hint="Files issues from this template."
                intake={byTemplate.get(template.id)}
                templateId={template.id}
                disabled={disabled}
                onChange={(next) => {
                  void submit(next);
                }}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
};

export default EmailIntakeSection;
