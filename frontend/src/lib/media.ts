/**
 * Inline images and videos in a description or comment. A body stores only the
 * stable content path of an attachment, `/api/workspaces/{ws}/attachments/{id}/content?issue_id={issue}`,
 * with `&media=video` on a video, so the Markdown never carries a credential
 * and still reads as an image embed to GitHub and to email. The short lived
 * token that opens it is appended when the page renders, from the media token
 * map the member route or the share link hands out.
 */

import { appConfig } from '../config/app';

/** What an embed shows as. */
export type MediaKind = 'image' | 'video';

/** The image types that embed inline. SVG is left out, as the server does. */
export const INLINE_IMAGE_TYPES: string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

/** The video types that embed inline with native controls. */
export const INLINE_VIDEO_TYPES: string[] = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
];

/** The largest video the presign route accepts, in bytes. */
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

/** The marker a stored path carries when it embeds a video. */
const VIDEO_MARKER = 'media=video';

/** A stored content path, with the ids it names. */
const CONTENT_PATH =
  /^\/api\/workspaces\/([A-Za-z0-9_-]{1,64})\/attachments\/([A-Za-z0-9_-]{1,64})\/content\?issue_id=([A-Za-z0-9_-]{1,64})(?:&media=video)?$/;

/** Every content path in a body, for collecting the ids it embeds. */
const CONTENT_PATHS =
  /\/api\/workspaces\/[A-Za-z0-9_-]{1,64}\/attachments\/([A-Za-z0-9_-]{1,64})\/content\?issue_id=/g;

/** How a content type embeds, or null when it becomes a file link. */
export const mediaKindOf = (contentType: string): MediaKind | null => {
  const type = contentType.toLowerCase();
  if (INLINE_IMAGE_TYPES.includes(type)) return 'image';
  if (INLINE_VIDEO_TYPES.includes(type)) return 'video';
  return null;
};

/** The stable path a body stores for one attachment. */
export const contentPath = (
  workspaceId: string,
  attachmentId: string,
  issueId: string,
  kind: MediaKind | null = null
): string => {
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/attachments/${encodeURIComponent(attachmentId)}/content?issue_id=${encodeURIComponent(issueId)}`;
  return kind === 'video' ? `${base}&${VIDEO_MARKER}` : base;
};

/** Whether a link or embed target is a stored content path. */
export const isContentPath = (src: string): boolean =>
  CONTENT_PATH.test(src.trim());

/** Whether an embed target is a video. */
export const isVideoSrc = (src: string): boolean =>
  isContentPath(src) && src.includes(`&${VIDEO_MARKER}`);

/** The attachment a content path names, or null for any other target. */
export const attachmentIdOf = (src: string): string | null => {
  const match = CONTENT_PATH.exec(src.trim());
  return match === null ? null : (match[2] ?? null);
};

/** The attachment ids a body embeds or links, in order and without repeats. */
export const embeddedAttachmentIds = (
  body: string | null | undefined
): string[] => {
  const found: string[] = [];
  for (const match of (body ?? '').matchAll(CONTENT_PATHS)) {
    const id = match[1];
    if (id !== undefined && !found.includes(id)) found.push(id);
  }
  return found;
};

/** Whether an embed target is one the page may load. */
export const isEmbeddableSrc = (src: string): boolean =>
  isContentPath(src) || /^https:\/\//i.test(src.trim());

/**
 * The API origin a content path is served from. The configured base carries
 * the `/api` prefix the stored path already starts with, so it is dropped, and
 * the development default of `/api` resolves to the page's own origin.
 */
const apiOrigin = (): string => appConfig.apiBaseUrl.replace(/\/api\/?$/, '');

/**
 * The URL an embed or link loads right now, or null when it cannot load yet
 * because no token for that attachment is held.
 */
export const resolveMediaUrl = (
  src: string,
  tokens: Readonly<Record<string, string>>
): string | null => {
  const trimmed = src.trim();
  const attachmentId = attachmentIdOf(trimmed);
  if (attachmentId === null) {
    return /^https:\/\//i.test(trimmed) ? trimmed : null;
  }
  const token = tokens[attachmentId];
  if (token === undefined) return null;
  return `${apiOrigin()}${trimmed}&token=${encodeURIComponent(token)}`;
};
