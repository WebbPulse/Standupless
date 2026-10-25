/**
 * The description history of one issue: its kept versions, newest first, with
 * the selected one readable in full or as a line diff against the current text,
 * and a restore for anyone who may edit the issue.
 */

import React, { useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import { LuHistory } from 'react-icons/lu';
import {
  listDescriptionVersions,
  restoreDescriptionVersion,
} from '../../api/issues';
import { errorMessage } from '../../lib/errors';
import { personLabel, type Assignable } from '../../lib/issuePeople';
import { activityKey, descriptionVersionsKey } from '../../lib/queryKeys';
import { diffLines, hasChanges, type DiffLine } from '../../lib/textDiff';
import { showErrorToast, showToast } from '../../lib/toast';
import type { IssueDescriptionVersionRead, IssueRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import { Button } from '../ui/button';
import Dialog from '../ui/dialog';
import EmptyState from '../ui/empty-state';
import Markdown from '../ui/markdown';
import RelativeTime from '../ui/relative-time';
import { SkeletonRows } from '../ui/skeleton';

/** The name the issue menu and the command palette give this dialog. */
export const DESCRIPTION_HISTORY_LABEL = 'Description history';

/** How often the open dialog rereads the versions. */
const POLL_MS = 15000;

/** The rendered description's type, matching the issue body. */
const BODY_CLASS = 'text-sm leading-6 text-text';

/** How the selected version is shown. */
type Mode = 'changes' | 'version';

/** Props for DescriptionHistoryDialog. */
export interface DescriptionHistoryDialogProps {
  workspaceId: string;
  issue: IssueRead;
  people: Assignable[];
  canEdit: boolean;
  onRestored: (issue: IssueRead) => void;
  onClose: () => void;
}

/** The class one diff line is drawn with. */
const lineClass = (kind: DiffLine['kind']): string => {
  if (kind === 'added') return 'bg-success-soft text-text';
  if (kind === 'removed') return 'bg-danger-soft text-text';
  return 'text-text-muted';
};

/** The marker in front of one diff line. */
const lineMarker = (kind: DiffLine['kind']): string => {
  if (kind === 'added') return '+';
  if (kind === 'removed') return '-';
  return ' ';
};

/** The selected version against the current text, line by line. */
const DiffView: React.FC<{ lines: DiffLine[] }> = ({ lines }) => {
  if (!hasChanges(lines)) {
    return (
      <p className="text-sm text-text-muted">
        This version matches the current description.
      </p>
    );
  }
  return (
    <pre
      aria-label="Changes against the current description"
      className="overflow-x-auto rounded-md border border-line font-mono text-xs leading-5"
    >
      {lines.map((line, index) => (
        <div
          key={index}
          className={`flex gap-2 px-2 whitespace-pre-wrap ${lineClass(line.kind)}`}
        >
          <span aria-hidden="true" className="w-3 shrink-0 select-none">
            {lineMarker(line.kind)}
          </span>
          <span className="sr-only">
            {line.kind === 'same'
              ? ''
              : line.kind === 'added'
                ? 'In this version: '
                : 'In the current description: '}
          </span>
          <span className="min-w-0 break-words">{line.text || ' '}</span>
        </div>
      ))}
    </pre>
  );
};

/** One row of the version list. */
const VersionRow: React.FC<{
  version: IssueDescriptionVersionRead;
  current: boolean;
  selected: boolean;
  people: Assignable[];
  onSelect: () => void;
}> = ({ version, current, selected, people, onSelect }) => (
  <li>
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
      className={`flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors duration-100 focus-visible:outline-2 focus-visible:outline-accent ${
        selected ? 'bg-raised text-text' : 'text-text-muted hover:bg-surface'
      }`}
    >
      <span className="flex w-full items-center gap-2">
        <span className="truncate font-medium text-text">
          <RelativeTime value={version.edited_at} />
        </span>
        {current && (
          <span className="ml-auto shrink-0 rounded-sm bg-surface px-1.5 text-xs text-text-muted">
            Current
          </span>
        )}
      </span>
      <span className="truncate text-xs">
        {personLabel(
          people.find((person) => person.user_id === version.edited_by)
        )}
      </span>
    </button>
  </li>
);

/** The dialog listing an issue's description versions, with diff and restore. */
export const DescriptionHistoryDialog: React.FC<
  DescriptionHistoryDialogProps
> = ({ workspaceId, issue, people, canEdit, onRestored, onClose }) => {
  const auth = useQueryAuth();
  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listDescriptionVersions(workspaceId, issue.id, signal),
    {
      intervalMs: POLL_MS,
      queryKey: descriptionVersionsKey(issue.id),
      auth,
    }
  );
  const versions = useMemo(() => data ?? [], [data]);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('changes');
  const [restoring, setRestoring] = useState(false);

  const selected =
    versions.find((version) => version.version_id === chosenId) ??
    versions[1] ??
    versions[0] ??
    null;
  const isCurrent =
    selected !== null && selected.version_id === versions[0]?.version_id;
  const current = issue.body ?? '';
  const lines = useMemo(
    () => (selected === null ? [] : diffLines(current, selected.body)),
    [current, selected]
  );
  const matches = !hasChanges(lines);

  const restore = async (): Promise<void> => {
    if (selected === null) return;
    setRestoring(true);
    try {
      const saved = await restoreDescriptionVersion(
        workspaceId,
        issue.id,
        selected.version_id
      );
      onRestored(saved);
      invalidateQueries([
        descriptionVersionsKey(issue.id),
        activityKey(issue.id),
      ]);
      showToast('Description restored');
      onClose();
    } catch (failure) {
      showErrorToast(
        errorMessage(failure, 'Could not restore the description.')
      );
    } finally {
      setRestoring(false);
    }
  };

  return (
    <Dialog
      open
      size="xl"
      title={DESCRIPTION_HISTORY_LABEL}
      description="Edits made close together by one person are kept as one version."
      onClose={onClose}
    >
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the history.')}
        />
      )}
      {isLoading && data === null && <SkeletonRows label="Loading versions" />}
      {data !== null && versions.length === 0 && (
        <EmptyState
          icon={<LuHistory aria-hidden="true" className="h-5 w-5" />}
          message="No versions yet. A version is kept each time the description is saved."
        />
      )}
      {selected !== null && (
        <div className="flex flex-col gap-4 sm:flex-row">
          <ol
            aria-label="Versions"
            className="max-h-48 shrink-0 space-y-0.5 overflow-y-auto sm:max-h-[60vh] sm:w-56"
          >
            {versions.map((version, index) => (
              <VersionRow
                key={version.version_id}
                version={version}
                current={index === 0}
                selected={version.version_id === selected.version_id}
                people={people}
                onSelect={() => {
                  setChosenId(version.version_id);
                }}
              />
            ))}
          </ol>
          <section
            aria-label="Selected version"
            className="flex min-w-0 flex-1 flex-col gap-3"
          >
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant={mode === 'changes' ? 'secondary' : 'ghost'}
                aria-pressed={mode === 'changes'}
                onClick={() => {
                  setMode('changes');
                }}
              >
                Changes
              </Button>
              <Button
                size="sm"
                variant={mode === 'version' ? 'secondary' : 'ghost'}
                aria-pressed={mode === 'version'}
                onClick={() => {
                  setMode('version');
                }}
              >
                Full text
              </Button>
              {canEdit && !isCurrent && (
                <Button
                  size="sm"
                  variant="primary"
                  className="ml-auto"
                  disabled={restoring || matches}
                  onClick={() => {
                    void restore();
                  }}
                >
                  {restoring ? 'Restoring…' : 'Restore'}
                </Button>
              )}
            </div>
            <div className="max-h-[55vh] overflow-y-auto">
              {mode === 'changes' ? (
                <DiffView lines={lines} />
              ) : selected.body === '' ? (
                <p className="text-sm text-text-muted">Empty.</p>
              ) : (
                <Markdown source={selected.body} className={BODY_CLASS} />
              )}
            </div>
          </section>
        </div>
      )}
    </Dialog>
  );
};

export default DescriptionHistoryDialog;
