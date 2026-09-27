/**
 * Helpers for how an attachment reads, kept out of the chip components so a
 * component file exports only components and so the rules are tested alone.
 */

import { getAttachmentDownload } from '../api/discussion';
import type { AttachmentRead } from '../types/Api';
import { errorMessage } from './errors';
import { showErrorToast } from './toast';

/** Whether the attachment is an uploaded image a thumbnail can show. */
export const isImageAttachment = (attachment: AttachmentRead): boolean =>
  attachment.kind === 'file' &&
  (attachment.content_type ?? '').startsWith('image/');

/** The host a link points at, without a leading `www.`. */
export const linkHost = (url: string | null | undefined): string => {
  if (url === null || url === undefined) return '';
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** Opens a file in a new tab through a freshly minted signed URL. */
export const openAttachment = (
  workspaceId: string,
  attachment: AttachmentRead
): void => {
  getAttachmentDownload(
    workspaceId,
    attachment.attachment_id,
    attachment.issue_id
  )
    .then((link) => {
      globalThis.open(link.url, '_blank', 'noopener,noreferrer');
    })
    .catch((failure: unknown) => {
      showErrorToast(errorMessage(failure, 'Could not open that attachment.'));
    });
};

/** The files a drop or paste carried, ignoring anything that is not a file. */
export const filesFrom = (data: DataTransfer | null): File[] => {
  if (data === null) return [];
  return Array.from(data.files);
};

/** Whether a drag carries files, so a drop zone only lights up for them. */
export const dragHasFiles = (data: DataTransfer | null): boolean =>
  data !== null && Array.from(data.types).includes('Files');

/**
 * The typed text as a web address, or null when it is not one. A bare host such
 * as `example.com/page` gains `https://`, since that is what a person pasting
 * it meant, and anything that is not http or https is refused.
 */
export const normalizeLinkUrl = (value: string): string | null => {
  const typed = value.trim();
  if (typed === '' || /\s/.test(typed)) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(typed)
    ? typed
    : `https://${typed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
};
