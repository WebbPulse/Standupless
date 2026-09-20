/**
 * One issue's attachments: the URL kind, the file kind, and the download link
 * each file row offers. A download is minted per click rather than held on the
 * row, so a link in the page never outlives the caller's access to it.
 */

import React, { useCallback, useState } from 'react';
import { useMutationWithRefetch } from '@webbpulse/api-client/react';
import { LuFile, LuGlobe, LuX } from 'react-icons/lu';
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
import Button, { IconButton } from '../ui/button';
import Field from '../ui/field';
import Label from '../ui/label';
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

/** The text of a row's name, whether it is a link or a download button. */
const NAME_CLASS =
  'min-w-0 flex-1 truncate rounded-xs text-left text-sm text-text hover:underline';

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
      <h3 className="text-base font-semibold">Attachments</h3>

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
        <p className="text-sm text-text-muted">Nothing is attached yet.</p>
      ) : (
        <ul className="rounded-md border border-line">
          {rows.map((row) => (
            <li
              key={row.attachment_id}
              className="flex h-row items-center gap-2.5 border-b border-line px-3 transition-colors duration-100 last:border-b-0 hover:bg-surface"
            >
              {row.kind === 'url' ? (
                <>
                  {row.favicon_url !== null && row.favicon_url !== undefined ? (
                    <img
                      src={row.favicon_url}
                      alt=""
                      width={16}
                      height={16}
                      className="h-4 w-4 shrink-0 rounded-xs"
                    />
                  ) : (
                    <LuGlobe
                      aria-hidden="true"
                      className="h-3.5 w-3.5 shrink-0 text-text-faint"
                    />
                  )}
                  <a
                    href={row.url ?? '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={NAME_CLASS}
                  >
                    {row.title}
                  </a>
                </>
              ) : (
                <>
                  <LuFile
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 text-text-faint"
                  />
                  <button
                    type="button"
                    className={NAME_CLASS}
                    onClick={() => {
                      openDownload(row.attachment_id);
                    }}
                  >
                    {row.title}
                  </button>
                  <span className="shrink-0 text-xs text-text-muted">
                    {sizeLabel(row.size_bytes ?? 0)}
                  </span>
                </>
              )}

              <span className="shrink-0 text-xs text-text-muted">
                {timestampLabel(row.created_at)}
              </span>

              {(row.uploaded_by === currentUserId || isAdmin) && (
                <IconButton
                  label={`Remove ${row.title}`}
                  size="sm"
                  className="shrink-0"
                  onClick={() => {
                    void remove(row.attachment_id).catch(() => undefined);
                  }}
                >
                  <LuX className="h-3.5 w-3.5" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      )}

      {hasMore && !isLoading && (
        <Button
          variant="ghost"
          size="sm"
          disabled={isPaging}
          onClick={loadMore}
        >
          {isPaging ? 'Loading' : 'Load more'}
        </Button>
      )}

      {canAttach && (
        <div className="space-y-4 rounded-md border border-line bg-surface p-4">
          <div className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <Field
              id="attachment-url"
              label="Attach a link"
              type="url"
              placeholder="https://example.com/spec"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
              }}
            />
            <Field
              id="attachment-title"
              label="Link title"
              placeholder="Optional"
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
              }}
            />
            <Button
              variant="primary"
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
            <div className="min-w-0 flex-1 space-y-1">
              <Label htmlFor="attachment-file">Upload a file</Label>
              <input
                id="attachment-file"
                type="file"
                accept={UPLOAD_CONTENT_TYPES.join(',')}
                className="block w-full text-sm text-text-muted file:mr-3 file:h-8 file:rounded-sm file:border file:border-line-strong file:bg-bg file:px-3 file:text-sm file:font-medium file:text-text hover:file:bg-raised"
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                }}
              />
            </div>
            <Button
              variant="primary"
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
