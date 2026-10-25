/**
 * The workspace URL setting: the slug every link into the workspace carries.
 * The field checks the format and the reserved words as the admin types, then
 * asks the server whether the slug is free. Saving moves the workspace to the
 * new slug and keeps the old one as a redirect, so links already shared in
 * email, chat or GitHub keep landing here. The workspace provider follows the
 * redirect once the workspace is re-read, so this page moves to the new URL
 * on its own. Only an owner or an admin reaches this section.
 */

import React, { useEffect, useId, useState } from 'react';
import { checkSlugAvailability, updateWorkspace } from '../../api/workspaces';
import { useWorkspace } from '../../hooks/useWorkspace';
import { errorMessage } from '../../lib/errors';
import { validateSlug } from '../../lib/validation';
import type { SlugAvailabilityRead, WorkspaceRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Input from '../ui/input';

/** How long the field waits after the last keystroke before asking the server. */
export const AVAILABILITY_DELAY_MS = 300;

/** Props for WorkspaceUrlSection. */
export interface WorkspaceUrlSectionProps {
  workspace: WorkspaceRead;
}

/** The sentence for a slug the server says is unavailable. */
const unavailableMessage = (answer: SlugAvailabilityRead): string => {
  switch (answer.reason) {
    case 'reserved':
      return 'That URL is reserved. Pick another.';
    case 'invalid':
      return 'Use 3 to 40 characters: lowercase letters, numbers and hyphens.';
    case 'current':
      return 'This is the current URL.';
    default:
      return 'That URL is taken.';
  }
};

/** The origin links into this app start with, shown before the field. */
const urlPrefix = (): string => `${window.location.host}/w/`;

/** Edits, checks and saves the workspace URL slug. */
export const WorkspaceUrlSection: React.FC<WorkspaceUrlSectionProps> = ({
  workspace,
}) => {
  const { refresh } = useWorkspace();
  const [value, setValue] = useState(workspace.slug);
  const [syncedFrom, setSyncedFrom] = useState(workspace.slug);
  const [answer, setAnswer] = useState<SlugAvailabilityRead | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const hintId = `${fieldId}-hint`;

  if (syncedFrom !== workspace.slug) {
    setSyncedFrom(workspace.slug);
    setValue(workspace.slug);
  }

  const candidate = value.trim().toLowerCase();
  const changed = candidate !== workspace.slug;
  const formatError =
    candidate === '' ? 'Enter a URL.' : validateSlug(candidate);

  const wantsCheck = changed && formatError === null;

  useEffect(() => {
    if (!wantsCheck) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      checkSlugAvailability(workspace.id, candidate, controller.signal)
        .then((found) => {
          if (!controller.signal.aborted) setAnswer(found);
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailedFor(candidate);
        });
    }, AVAILABILITY_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [candidate, wantsCheck, workspace.id]);

  const current = answer !== null && answer.slug === candidate ? answer : null;
  const failed = failedFor === candidate && current === null;
  const checking = wantsCheck && current === null && !failed;
  const unavailable =
    current !== null && !current.available ? unavailableMessage(current) : null;
  const problem = changed ? (formatError ?? unavailable) : null;
  const canSave =
    changed && problem === null && !saving && (current !== null || failed);

  const save = async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await updateWorkspace(workspace.id, { slug: candidate });
      await refresh();
    } catch (failure) {
      setError(errorMessage(failure, 'Could not change the workspace URL.'));
    } finally {
      setSaving(false);
    }
  };

  const retired = workspace.retired_slugs ?? [];
  let status: string;
  if (problem !== null) status = problem;
  else if (!changed)
    status = 'Links with an earlier URL keep working and redirect to this one.';
  else if (checking) status = 'Checking availability...';
  else if (failed)
    status = 'Could not check availability. Saving still checks it.';
  else status = 'Available. Links with the current URL will redirect here.';

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Workspace URL</h3>
        <p className="text-sm text-text-muted">
          The address every link into this workspace uses. It can change three
          times a day, and no other workspace can take a URL this one used.
        </p>
      </div>
      <ErrorAlert message={error} />
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label htmlFor={fieldId} className="sr-only">
          Workspace URL
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center rounded-md border border-line focus-within:ring-2 focus-within:ring-accent">
            <span className="shrink-0 select-none pl-3 text-sm text-text-muted">
              {urlPrefix()}
            </span>
            <Input
              id={fieldId}
              value={value}
              maxLength={40}
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
              aria-describedby={hintId}
              aria-invalid={problem !== null}
              className="min-w-0 flex-1 border-0 pl-0.5 focus-visible:ring-0"
              onChange={(event) => {
                setValue(event.target.value);
              }}
            />
          </div>
          <Button type="submit" disabled={!canSave}>
            {saving ? 'Saving...' : 'Change URL'}
          </Button>
        </div>
        <p
          id={hintId}
          role="status"
          className={
            problem !== null ? 'text-sm text-danger' : 'text-sm text-text-muted'
          }
        >
          {status}
        </p>
      </form>
      {retired.length > 0 && (
        <p className="text-sm text-text-muted">
          Redirecting here: {retired.map((slug) => `/w/${slug}`).join(', ')}
        </p>
      )}
    </section>
  );
};

export default WorkspaceUrlSection;
