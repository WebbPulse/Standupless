/**
 * One issue's attachments: the URL kind, the file kind, and the download link
 * each file row offers. A download is minted per click rather than held on the
 * row, so a link in the page never outlives the caller's access to it.
 */

import React, { useCallback, useState } from 'react';
import { useMutationWithRefetch } from '@webbpulse/api-client/react';
import {
  appendAttachments,
  createUrlAttachment,
  deleteAttachment,
  getAttachmentDownload,
  listAttachments,
  uploadAttachment,
} from '../../api/discussion';
import { useCursorPages, type CursorPage } from '../../hooks/useCursorPages';
import { errorMessage } from '../../lib/errors';
import { timestampLabel } from '../../lib/issueDisplay';
import { attachmentsKey } from '../../lib/queryKeys';
import {
  UPLOAD_CONTENT_TYPES,
  describeUploadRefusal,
  sizeLabel,
} from '../../lib/uploads';
import type { AttachmentRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Field from '../ui/field';
import Spinner from '../ui/spinner';

/** Props for AttachmentsSection: which issue, and what its reader may do. */
export interface AttachmentsSectionProps {
  workspaceId: string;
  issueId: string;
  /** The signed in user, so a row knows whether the caller uploaded it. */
  currentUserId: string;
  /** Whether the caller may attach at all. A project reader may not. */
  canAttach: boolean;
  /** Whether the caller administers the project, who may delete any row. */
  isAdmin: boolean;
}

/** How many attachments one page asks for. */
const PAGE_SIZE = 50;

/** How often the list is re-read while the issue is open. */
const POLL_MS = 60000;

/** Lists and writes one issue's attachments. */
export const AttachmentsSection: React.FC<AttachmentsSectionProps> = ({
  workspaceId,
  issueId,
  currentUserId,
  canAttach,
  isAdmin,
}) => {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const queryKey = attachmentsKey(issueId);

  const read = useCallback(
    async (
      cursor: string | undefined,
      signal?: AbortSignal
    ): Promise<CursorPage<AttachmentRead>> => {
      const page = await listAttachments(
        workspaceId,
        issueId,
        { limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
        signal
      );
      return { rows: page.attachments, nextCursor: page.next_cursor };
    },
    [workspaceId, issueId]
  );

  const merge = useCallback(
    (held: AttachmentRead[], incoming: AttachmentRead[]): AttachmentRead[] =>
      appendAttachments(held, incoming),
    []
  );

  const { rows, error, isLoading, isPaging, hasMore, loadMore } =
    useCursorPages(read, merge, {
      queryKey,
      enabled: workspaceId !== '' && issueId !== '',
      intervalMs: POLL_MS,
    });

  const {
    mutate: attachUrl,
    isMutating: isAttaching,
    error: urlError,
  } = useMutationWithRefetch(
    (href: string, label: string) =>
      createUrlAttachment(workspaceId, {
        issue_id: issueId,
        url: href,
        ...(label === '' ? {} : { title: label }),
      }),
    queryKey
  );

  const {
    mutate: upload,
    isMutating: isUploading,
    error: uploadError,
  } = useMutationWithRefetch(
    (chosen: File) => uploadAttachment(workspaceId, issueId, chosen),
    queryKey
  );

  const { mutate: remove, error: removeError } = useMutationWithRefetch(
    (attachmentId: string) =>
      deleteAttachment(workspaceId, attachmentId, issueId),
    queryKey
  );

  const refusal = file === null ? null : describeUploadRefusal(file);

  const openDownload = (attachmentId: string): void => {
    setDownloadError(null);
    getAttachmentDownload(workspaceId, attachmentId, issueId)
      .then((link) => {
        globalThis.open(link.url, '_blank', 'noopener,noreferrer');
      })
      .catch((failure: unknown) => {
        setDownloadError(
          errorMessage(failure, 'Could not open that attachment.')
        );
      });
  };

  return (
    <section className="space-y-3">
      <h3 className="text-base font-medium text-white">Attachments</h3>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the attachments.')}
        />
      )}
      {urlError !== null && (
        <ErrorAlert
          message={errorMessage(urlError, 'Could not attach that link.')}
        />
      )}
      {uploadError !== null && (
        <ErrorAlert
          message={errorMessage(uploadError, 'Could not upload that file.')}
        />
      )}
      {removeError !== null && (
        <ErrorAlert
          message={errorMessage(removeError, 'Could not remove that file.')}
        />
      )}
      <ErrorAlert message={downloadError} />

      {isLoading ? (
        <Spinner label="Loading attachments" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-400">Nothing is attached yet.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              key={row.attachment_id}
              className="flex flex-wrap items-center gap-3 rounded-md border border-slate-700 px-3 py-2"
            >
              {row.kind === 'url' ? (
                <>
                  {row.favicon_url !== null &&
                    row.favicon_url !== undefined && (
                      <img
                        src={row.favicon_url}
                        alt=""
                        width={16}
                        height={16}
                        className="h-4 w-4"
                      />
                    )}
                  <a
                    href={row.url ?? '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-sky-400 hover:text-sky-300"
                  >
                    {row.title}
                  </a>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="text-sm text-sky-400 hover:text-sky-300"
                    onClick={() => {
                      openDownload(row.attachment_id);
                    }}
                  >
                    {row.title}
                  </button>
                  <span className="text-xs text-slate-500">
                    {sizeLabel(row.size_bytes ?? 0)}
                  </span>
                </>
              )}

              <span className="text-xs text-slate-500">
                {timestampLabel(row.created_at)}
              </span>

              {(row.uploaded_by === currentUserId || isAdmin) && (
                <Button
                  variant="secondary"
                  className="ml-auto"
                  aria-label={`Remove ${row.title}`}
                  onClick={() => {
                    void remove(row.attachment_id).catch(() => undefined);
                  }}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {hasMore && !isLoading && (
        <Button variant="secondary" disabled={isPaging} onClick={loadMore}>
          {isPaging ? 'Loading' : 'Load more'}
        </Button>
      )}

      {canAttach && (
        <div className="space-y-4 rounded-md border border-slate-700 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field
              id="attachment-url"
              label="Attach a link"
              type="url"
              className="w-72"
              placeholder="https://example.com/spec"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
              }}
            />
            <Field
              id="attachment-title"
              label="Link title"
              className="w-48"
              placeholder="Optional"
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
              }}
            />
            <Button
              disabled={isAttaching || url.trim() === ''}
              onClick={() => {
                void attachUrl(url.trim(), title.trim())
                  .then(() => {
                    setUrl('');
                    setTitle('');
                  })
                  .catch(() => undefined);
              }}
            >
              {isAttaching ? 'Attaching' : 'Attach link'}
            </Button>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label
                htmlFor="attachment-file"
                className="block text-sm font-medium text-slate-200"
              >
                Upload a file
              </label>
              <input
                id="attachment-file"
                type="file"
                accept={UPLOAD_CONTENT_TYPES.join(',')}
                className="block text-sm text-slate-300 file:mr-3 file:rounded-md file:border-0 file:bg-slate-700 file:px-3 file:py-2 file:text-sm file:text-slate-100"
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                }}
              />
            </div>
            <Button
              disabled={isUploading || file === null || refusal !== null}
              onClick={() => {
                if (file === null) return;
                void upload(file)
                  .then(() => {
                    setFile(null);
                  })
                  .catch(() => undefined);
              }}
            >
              {isUploading ? 'Uploading' : 'Upload'}
            </Button>
          </div>

          <ErrorAlert message={refusal} />
        </div>
      )}
    </section>
  );
};

export default AttachmentsSection;
