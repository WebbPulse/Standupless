/**
 * Uploads files to one issue and tracks each one while it is in flight, so a
 * composer can show a chip per file, refuse the ones the server would refuse
 * before any bytes move, and hand the finished attachment ids to the comment
 * it posts. A finished upload is held out of the issue's rail until the comment
 * posts, so a file being written about never shows beside the issue first.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { deleteAttachment, uploadAttachment } from '../api/discussion';
import { errorMessage } from '../lib/errors';
import { holdUploads, releaseUploads } from '../lib/pendingUploads';
import { attachmentsKey } from '../lib/queryKeys';
import { showErrorToast } from '../lib/toast';
import { describeUploadRefusal } from '../lib/uploads';
import type { AttachmentRead } from '../types/Api';

/** One file the person added, and where its upload stands. */
export interface PendingUpload {
  /** A local id, stable from the moment the file is added. */
  id: string;
  name: string;
  size: number;
  contentType: string;
  status: 'uploading' | 'done';
  attachment: AttachmentRead | null;
}

/** What {@link useAttachmentUploads} hands back. */
export interface AttachmentUploads {
  pending: PendingUpload[];
  /** True while any file is still uploading. */
  isUploading: boolean;
  /** Starts uploading each file the server would accept, refusing the rest. */
  add: (files: File[]) => void;
  /** Drops one file, deleting it from the issue if it already landed. */
  remove: (id: string) => void;
  /** The ids of the finished uploads, in the order they were added. */
  attachmentIds: () => string[];
  /** Forgets every file without deleting anything, after a post used them. */
  reset: () => void;
}

/** Uploads files to an issue, one chip per file. */
export const useAttachmentUploads = (
  workspaceId: string,
  issueId: string
): AttachmentUploads => {
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const counter = useRef(0);
  const latest = useRef<PendingUpload[]>([]);
  const mounted = useRef(true);
  latest.current = pending;

  const add = useCallback(
    (files: File[]) => {
      for (const file of files) {
        const refusal = describeUploadRefusal(file);
        if (refusal !== null) {
          showErrorToast(`${file.name}: ${refusal}`);
          continue;
        }
        counter.current += 1;
        const id = `upload-${String(counter.current)}`;
        setPending((held) => [
          ...held,
          {
            id,
            name: file.name,
            size: file.size,
            contentType: file.type,
            status: 'uploading',
            attachment: null,
          },
        ]);
        uploadAttachment(workspaceId, issueId, file)
          .then((attachment) => {
            if (mounted.current) {
              holdUploads(issueId, [attachment.attachment_id]);
            }
            setPending((held) =>
              held.map((row) =>
                row.id === id ? { ...row, status: 'done', attachment } : row
              )
            );
          })
          .catch((failure: unknown) => {
            showErrorToast(
              errorMessage(failure, `Could not upload ${file.name}.`)
            );
            setPending((held) => held.filter((row) => row.id !== id));
          });
      }
    },
    [workspaceId, issueId]
  );

  const remove = useCallback(
    (id: string) => {
      const row = latest.current.find((item) => item.id === id);
      setPending((held) => held.filter((item) => item.id !== id));
      if (row?.attachment !== null && row?.attachment !== undefined) {
        const attachmentId = row.attachment.attachment_id;
        deleteAttachment(workspaceId, attachmentId, issueId)
          .then(() => {
            invalidateQueries(attachmentsKey(issueId));
          })
          .catch(() => undefined)
          .finally(() => {
            releaseUploads(issueId, [attachmentId]);
          });
      }
    },
    [workspaceId, issueId]
  );

  const attachmentIds = useCallback(
    () =>
      latest.current.flatMap((row) =>
        row.attachment === null ? [] : [row.attachment.attachment_id]
      ),
    []
  );

  const reset = useCallback(() => {
    latest.current = [];
    setPending([]);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      releaseUploads(
        issueId,
        latest.current.flatMap((row) =>
          row.attachment === null ? [] : [row.attachment.attachment_id]
        )
      );
    };
  }, [issueId]);

  return {
    pending,
    isUploading: pending.some((row) => row.status === 'uploading'),
    add,
    remove,
    attachmentIds,
    reset,
  };
};

export default useAttachmentUploads;
