/**
 * The links and files on the issue itself, as chips in a rail section. Files
 * posted with a comment show in that comment instead, so the page hands in the
 * ids its loaded comments carry and they are left out here rather than shown
 * twice. Files a comment draft has uploaded but not yet posted are left out
 * too, read from the pending upload store. The section's add menu offers a link or a file.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { LuLink2, LuPaperclip, LuPlus } from 'react-icons/lu';
import {
  appendAttachments,
  deleteAttachment,
  listAttachments,
} from '../../api/discussion';
import { useCursorPages, type CursorPage } from '../../hooks/useCursorPages';
import { errorMessage } from '../../lib/errors';
import { usePendingUploads } from '../../lib/pendingUploads';
import { attachmentsKey } from '../../lib/queryKeys';
import { showErrorToast, showToast } from '../../lib/toast';
import type { AttachmentRead } from '../../types/Api';
import { AttachmentChip } from '../discussion/AttachmentChips';
import { ErrorAlert } from '../ui/alert';
import { IconButton } from '../ui/button';
import Menu, { MenuItem } from '../ui/menu';
import RailSection from './RailSection';

/** Props for IssueResources. */
export interface IssueResourcesProps {
  workspaceId: string;
  issueId: string;
  currentUserId: string;
  canEdit: boolean;
  isAdmin: boolean;
  /** Attachment ids shown in a comment, and so not repeated here. */
  hiddenIds: Set<string>;
  /** Opens the add link dialog. */
  onAddLink: () => void;
  /** Uploads files to the issue. */
  onAttachFiles: (files: File[]) => void;
}

/** How many attachments one page asks for. */
const PAGE_SIZE = 50;

/** How often the first page is re-read while the issue is open. */
const POLL_MS = 60000;

/** The links and attachments section of the rail. */
export const IssueResources: React.FC<IssueResourcesProps> = ({
  workspaceId,
  issueId,
  currentUserId,
  canEdit,
  isAdmin,
  hiddenIds,
  onAddLink,
  onAttachFiles,
}) => {
  const picker = useRef<HTMLInputElement>(null);
  const drafted = usePendingUploads(issueId);

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
      queryKey: attachmentsKey(issueId),
      enabled: workspaceId !== '' && issueId !== '',
      intervalMs: POLL_MS,
    });

  useEffect(() => {
    if (hasMore && !isPaging && !isLoading) loadMore();
  }, [hasMore, isPaging, isLoading, loadMore]);

  const remove = (attachment: AttachmentRead): void => {
    deleteAttachment(workspaceId, attachment.attachment_id, issueId)
      .then(() => {
        invalidateQueries(attachmentsKey(issueId));
        showToast(attachment.kind === 'url' ? 'Link removed' : 'File removed');
      })
      .catch((failure: unknown) => {
        showErrorToast(errorMessage(failure, 'Could not remove that.'));
      });
  };

  const shown = rows.filter(
    (row) =>
      !hiddenIds.has(row.attachment_id) && !drafted.has(row.attachment_id)
  );
  const ordered = [
    ...shown.filter((row) => row.kind === 'url'),
    ...shown.filter((row) => row.kind !== 'url'),
  ];

  if (!isLoading && shown.length === 0 && !canEdit && error === null) {
    return null;
  }

  const addMenu = canEdit ? (
    <>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        aria-hidden="true"
        tabIndex={-1}
        data-testid="issue-file-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length > 0) onAttachFiles(files);
        }}
      />
      <Menu
        label="Add to links and attachments"
        align="end"
        trigger={(props) => (
          <IconButton
            label="Add link or file"
            size="sm"
            className="h-5 w-5 shrink-0"
            {...props}
          >
            <LuPlus className="h-3.5 w-3.5" />
          </IconButton>
        )}
      >
        <MenuItem onSelect={onAddLink}>
          <LuLink2 aria-hidden="true" className="h-3.5 w-3.5" />
          Add link
        </MenuItem>
        <MenuItem
          onSelect={() => {
            picker.current?.click();
          }}
        >
          <LuPaperclip aria-hidden="true" className="h-3.5 w-3.5" />
          Upload file
        </MenuItem>
      </Menu>
    </>
  ) : undefined;

  return (
    <RailSection
      title="Links and attachments"
      {...(shown.length > 0 ? { count: String(shown.length) } : {})}
      {...(addMenu === undefined ? {} : { actions: addMenu })}
    >
      {error !== null ? (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the attachments.')}
        />
      ) : isLoading ? null : ordered.length === 0 ? (
        <p className="py-1 text-xs text-text-faint">No links or attachments</p>
      ) : (
        <ul aria-label="Links and attachments" className="space-y-1">
          {ordered.map((item) => (
            <li key={item.attachment_id} className="flex min-w-0">
              <AttachmentChip
                attachment={item}
                workspaceId={workspaceId}
                {...(canEdit && (isAdmin || item.uploaded_by === currentUserId)
                  ? { onRemove: remove }
                  : {})}
              />
            </li>
          ))}
        </ul>
      )}
    </RailSection>
  );
};

export default IssueResources;
