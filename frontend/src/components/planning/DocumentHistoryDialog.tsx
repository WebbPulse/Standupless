/**
 * The version history of one document: the current text and its kept earlier
 * versions, newest first, with the selected one readable in full or as a line
 * diff against the current body, and a restore for anyone who may edit the
 * document. A restore keeps the body it replaced as a version and offers Undo
 * through the shared undo history, which writes that body back.
 */

import React, { useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import {
  listDocumentVersions,
  restoreDocumentVersion,
  updateDocument,
} from '../../api/documents';
import { errorMessage } from '../../lib/errors';
import { personLabel, type Assignable } from '../../lib/issuePeople';
import { documentKey, documentVersionsKey } from '../../lib/queryKeys';
import { diffLines, hasChanges } from '../../lib/textDiff';
import { showErrorToast } from '../../lib/toast';
import { pushUndo } from '../../lib/undo';
import type { DocumentRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import { Button } from '../ui/button';
import Dialog from '../ui/dialog';
import Markdown from '../ui/markdown';
import RelativeTime from '../ui/relative-time';
import { SkeletonRows } from '../ui/skeleton';
import TextDiff from '../ui/text-diff';

/** The name the document menu gives this dialog. */
export const DOCUMENT_HISTORY_LABEL = 'Version history';

/** The id the current text's row carries in place of a version id. */
const CURRENT = 'current';

/** How often the open dialog rereads the versions. */
const POLL_MS = 15000;

/** The rendered body's type, matching the document page. */
const BODY_CLASS = 'text-sm leading-6 text-text';

/** How the selected version is shown. */
type Mode = 'changes' | 'version';

/** One row of the list: the current text or a kept version. */
interface Row {
  id: string;
  title: string;
  body: string;
  editedBy: string;
  editedAt: string;
}

/** Props for DocumentHistoryDialog. */
export interface DocumentHistoryDialogProps {
  workspaceId: string;
  document: DocumentRead;
  people: Assignable[];
  onRestored: (document: DocumentRead) => void;
  onClose: () => void;
}

/** One row of the version list. */
const VersionRow: React.FC<{
  row: Row;
  current: boolean;
  selected: boolean;
  people: Assignable[];
  onSelect: () => void;
}> = ({ row, current, selected, people, onSelect }) => (
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
          <RelativeTime value={row.editedAt} />
        </span>
        {current && (
          <span className="ml-auto shrink-0 rounded-sm bg-surface px-1.5 text-xs text-text-muted">
            Current
          </span>
        )}
      </span>
      <span className="truncate text-xs">
        {personLabel(people.find((person) => person.user_id === row.editedBy))}
      </span>
    </button>
  </li>
);

/** The dialog listing a document's versions, with diff and restore. */
export const DocumentHistoryDialog: React.FC<DocumentHistoryDialogProps> = ({
  workspaceId,
  document,
  people,
  onRestored,
  onClose,
}) => {
  const auth = useQueryAuth();
  const documentId = document.document_id;
  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listDocumentVersions(workspaceId, documentId, signal),
    {
      intervalMs: POLL_MS,
      queryKey: documentVersionsKey(workspaceId, documentId),
      auth,
    }
  );
  const current = useMemo<Row>(
    () => ({
      id: CURRENT,
      title: document.title,
      body: document.body,
      editedBy: document.updated_by,
      editedAt: document.updated_at,
    }),
    [document]
  );
  const rows = useMemo<Row[]>(
    () => [
      current,
      ...(data ?? []).map((version) => ({
        id: version.version_id,
        title: version.title,
        body: version.body,
        editedBy: version.edited_by,
        editedAt: version.edited_at,
      })),
    ],
    [data, current]
  );
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('changes');
  const [restoring, setRestoring] = useState(false);

  const selected =
    rows.find((row) => row.id === chosenId) ?? rows[1] ?? current;
  const isCurrent = selected.id === CURRENT;
  const lines = useMemo(
    () => diffLines(document.body, selected.body),
    [document.body, selected.body]
  );
  const matches = !hasChanges(lines);

  const refresh = (): void => {
    invalidateQueries([
      documentVersionsKey(workspaceId, documentId),
      documentKey(workspaceId, documentId),
    ]);
  };

  const restore = async (): Promise<void> => {
    if (isCurrent) return;
    const replaced = document.body;
    setRestoring(true);
    try {
      const saved = await restoreDocumentVersion(
        workspaceId,
        documentId,
        selected.id,
        document.body_version
      );
      onRestored(saved);
      refresh();
      pushUndo(workspaceId, `Restored ${saved.title}`, async () => {
        const reverted = await updateDocument(workspaceId, documentId, {
          body: replaced,
          ...(saved.body_version === undefined
            ? {}
            : { base_body_version: saved.body_version }),
        });
        onRestored(reverted);
        refresh();
      });
      onClose();
    } catch (failure) {
      showErrorToast(errorMessage(failure, 'Could not restore the version.'));
    } finally {
      setRestoring(false);
    }
  };

  return (
    <Dialog
      open
      size="xl"
      title={DOCUMENT_HISTORY_LABEL}
      description="A version is kept when someone else edits the document, or after a pause in editing."
      onClose={onClose}
    >
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the history.')}
        />
      )}
      {isLoading && data === null && <SkeletonRows label="Loading versions" />}
      {data !== null && rows.length === 1 && (
        <p className="text-sm text-text-muted">No earlier versions yet.</p>
      )}
      {rows.length > 1 && (
        <div className="flex flex-col gap-4 sm:flex-row">
          <ol
            aria-label="Versions"
            className="max-h-48 shrink-0 space-y-0.5 overflow-y-auto sm:max-h-[60vh] sm:w-56"
          >
            {rows.map((row) => (
              <VersionRow
                key={row.id}
                row={row}
                current={row.id === CURRENT}
                selected={row.id === selected.id}
                people={people}
                onSelect={() => {
                  setChosenId(row.id);
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
              {document.can_edit && !isCurrent && (
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
            <p className="truncate text-sm font-medium text-text">
              {selected.title}
            </p>
            <div className="max-h-[55vh] overflow-y-auto">
              {mode === 'changes' ? (
                <TextDiff lines={lines} subject="document" />
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

export default DocumentHistoryDialog;
