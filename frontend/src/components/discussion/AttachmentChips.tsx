/**
 * How an attachment shows wherever it appears: a link as a chip with its
 * favicon, title and host, a file as a chip with its size, and an image as a
 * thumbnail that opens full size in a lightbox. File bytes sit behind a
 * short-lived signed URL, so a thumbnail mints one when it mounts and a file
 * chip mints one per click rather than holding a link that could outlive the
 * caller's access.
 */

import React, { useEffect, useState } from 'react';
import { LuFile, LuFileText, LuGlobe, LuImage, LuX } from 'react-icons/lu';
import { getAttachmentDownload } from '../../api/discussion';
import {
  isImageAttachment,
  linkHost,
  openAttachment,
} from '../../lib/attachments';
import { cn } from '../../lib/cn';
import { sizeLabel } from '../../lib/uploads';
import type { AttachmentRead } from '../../types/Api';
import { IconButton } from '../ui/button';

/** The chip's frame, shared by links and files so the row reads as one set. */
const CHIP_CLASS =
  'group/chip relative inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-sm border border-line bg-surface pr-2 pl-2 text-xs text-text transition-colors duration-100 hover:border-line-strong hover:bg-raised';

/** Props shared by every chip. */
interface ChipProps {
  attachment: AttachmentRead;
  workspaceId: string;
  /** Removes the attachment, or undefined when the reader may not. */
  onRemove?: (attachment: AttachmentRead) => void;
}

/** The remove control that shows when a chip is hovered or focused. */
const RemoveButton: React.FC<{
  attachment: AttachmentRead;
  onRemove: (attachment: AttachmentRead) => void;
}> = ({ attachment, onRemove }) => (
  <IconButton
    label={`Remove ${attachment.title}`}
    size="sm"
    className="-mr-1.5 h-5 w-5 opacity-0 group-focus-within/chip:opacity-100 group-hover/chip:opacity-100"
    onClick={() => {
      onRemove(attachment);
    }}
  >
    <LuX className="h-3 w-3" />
  </IconButton>
);

/** A link attachment: favicon, title and host. */
export const LinkChip: React.FC<ChipProps> = ({ attachment, onRemove }) => {
  const host = linkHost(attachment.url);
  const [faviconFailed, setFaviconFailed] = useState(false);
  const favicon = attachment.favicon_url;
  return (
    <span className={CHIP_CLASS}>
      {favicon !== null && favicon !== undefined && !faviconFailed ? (
        <img
          src={favicon}
          alt=""
          width={14}
          height={14}
          className="h-3.5 w-3.5 shrink-0 rounded-xs"
          onError={() => {
            setFaviconFailed(true);
          }}
        />
      ) : (
        <LuGlobe
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-text-faint"
        />
      )}
      <a
        href={attachment.url ?? '#'}
        target="_blank"
        rel="noopener noreferrer"
        className="min-w-0 truncate rounded-xs font-medium after:absolute after:inset-0"
      >
        {attachment.title}
      </a>
      {host !== '' && host !== attachment.title && (
        <span className="shrink-0 truncate text-text-faint">{host}</span>
      )}
      {onRemove !== undefined && (
        <span className="relative z-10">
          <RemoveButton attachment={attachment} onRemove={onRemove} />
        </span>
      )}
    </span>
  );
};

/** A file attachment: an icon, its name and size, opened on click. */
export const FileChip: React.FC<ChipProps> = ({
  attachment,
  workspaceId,
  onRemove,
}) => {
  const Icon = isImageAttachment(attachment)
    ? LuImage
    : (attachment.content_type ?? '').startsWith('text/') ||
        attachment.content_type === 'application/pdf'
      ? LuFileText
      : LuFile;
  return (
    <span className={CHIP_CLASS}>
      <Icon
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0 text-text-faint"
      />
      <button
        type="button"
        className="min-w-0 truncate rounded-xs text-left font-medium after:absolute after:inset-0"
        onClick={() => {
          openAttachment(workspaceId, attachment);
        }}
      >
        {attachment.title}
      </button>
      {attachment.size_bytes !== null &&
        attachment.size_bytes !== undefined && (
          <span className="shrink-0 text-text-faint">
            {sizeLabel(attachment.size_bytes)}
          </span>
        )}
      {onRemove !== undefined && (
        <span className="relative z-10">
          <RemoveButton attachment={attachment} onRemove={onRemove} />
        </span>
      )}
    </span>
  );
};

/** Either chip, picked by the attachment's kind. */
export const AttachmentChip: React.FC<ChipProps> = (props) =>
  props.attachment.kind === 'url' ? (
    <LinkChip {...props} />
  ) : (
    <FileChip {...props} />
  );

/** Mints a signed URL for an image once, for as long as it is mounted. */
const useSignedUrl = (
  workspaceId: string,
  attachment: AttachmentRead
): { url: string | null; failed: boolean } => {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const { attachment_id: attachmentId, issue_id: issueId } = attachment;

  useEffect(() => {
    let live = true;
    getAttachmentDownload(workspaceId, attachmentId, issueId)
      .then((link) => {
        if (live) setUrl(link.url);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [workspaceId, attachmentId, issueId]);

  return { url, failed };
};

/** A full-size image over the page, closed by Escape or a click outside it. */
const Lightbox: React.FC<{
  url: string;
  title: string;
  onClose: () => void;
}> = ({ url, title, onClose }) => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/80 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="absolute top-3 right-3">
        <IconButton
          label="Close"
          size="sm"
          className="text-white hover:bg-white/10 hover:text-white"
          onClick={onClose}
        >
          <LuX className="h-4 w-4" />
        </IconButton>
      </div>
      <img
        src={url}
        alt={title}
        className="max-h-[85vh] max-w-full rounded-md object-contain shadow-overlay"
      />
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-white/70 hover:text-white"
      >
        {title}
      </a>
    </div>
  );
};

/** An image thumbnail that opens in a lightbox. */
export const ImageThumbnail: React.FC<ChipProps> = ({
  attachment,
  workspaceId,
  onRemove,
}) => {
  const { url, failed } = useSignedUrl(workspaceId, attachment);
  const [open, setOpen] = useState(false);

  if (failed) {
    return (
      <FileChip
        attachment={attachment}
        workspaceId={workspaceId}
        {...(onRemove === undefined ? {} : { onRemove })}
      />
    );
  }

  return (
    <span className="group/chip relative inline-block">
      <button
        type="button"
        aria-label={`Open ${attachment.title}`}
        className={cn(
          'block h-28 max-w-60 min-w-20 overflow-hidden rounded-md border border-line bg-surface transition-colors duration-100 hover:border-line-strong',
          url === null ? 'w-40 animate-pulse' : ''
        )}
        disabled={url === null}
        onClick={() => {
          setOpen(true);
        }}
      >
        {url !== null && (
          <img
            src={url}
            alt={attachment.title}
            className="h-full w-auto max-w-60 object-cover"
          />
        )}
      </button>
      {onRemove !== undefined && (
        <span className="absolute top-1 right-1 rounded-sm bg-overlay">
          <RemoveButton attachment={attachment} onRemove={onRemove} />
        </span>
      )}
      {open && url !== null && (
        <Lightbox
          url={url}
          title={attachment.title}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </span>
  );
};

/** Props for AttachmentList: the attachments and what the reader may do. */
export interface AttachmentListProps {
  attachments: AttachmentRead[];
  workspaceId: string;
  onRemove?: (attachment: AttachmentRead) => void;
  /** Whether the reader may remove this one, when not every row is theirs. */
  canRemove?: (attachment: AttachmentRead) => boolean;
  /** Anything to show after the chips, such as an add button. */
  trailing?: React.ReactNode;
  className?: string;
}

/**
 * Images first as thumbnails, then everything else as chips, the way a posted
 * comment shows what was attached to it.
 */
export const AttachmentList: React.FC<AttachmentListProps> = ({
  attachments,
  workspaceId,
  onRemove,
  canRemove,
  trailing,
  className = '',
}) => {
  if (attachments.length === 0 && trailing === undefined) return null;
  const images = attachments.filter(isImageAttachment);
  const others = attachments.filter((item) => !isImageAttachment(item));
  const removal = (item: AttachmentRead) =>
    onRemove === undefined || canRemove?.(item) === false ? {} : { onRemove };
  return (
    <div className={cn('space-y-2', className)}>
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((item) => (
            <ImageThumbnail
              key={item.attachment_id}
              attachment={item}
              workspaceId={workspaceId}
              {...removal(item)}
            />
          ))}
        </div>
      )}
      {(others.length > 0 || trailing !== undefined) && (
        <div className="flex flex-wrap gap-1.5">
          {others.map((item) => (
            <AttachmentChip
              key={item.attachment_id}
              attachment={item}
              workspaceId={workspaceId}
              {...removal(item)}
            />
          ))}
          {trailing}
        </div>
      )}
    </div>
  );
};

export default AttachmentList;
