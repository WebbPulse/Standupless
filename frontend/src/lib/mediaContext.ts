/**
 * The media tokens a page holds, shared with every embed below it through
 * context, and the local previews of files uploaded in this tab. A preview lets
 * an image dropped into a comment show at once from the bytes already in
 * memory, rather than blinking empty until the next token read names it.
 */

import { createContext, useContext } from 'react';
import { resolveMediaUrl, attachmentIdOf } from './media';

/** What the page knows about opening embeds. */
export interface MediaContextValue {
  /** Attachment id to token, for the attachments the reader may open. */
  tokens: Readonly<Record<string, string>>;
  /** Asks for a fresh token read, after an upload names a new attachment. */
  refresh: () => void;
}

/** No tokens and nothing to refresh, for a surface outside any issue. */
const EMPTY: MediaContextValue = {
  tokens: {},
  refresh: () => undefined,
};

/** The media context. Provided per issue page and per share view. */
export const MediaContext = createContext<MediaContextValue>(EMPTY);

/** Object URLs for files uploaded in this tab, by attachment id. */
const previews = new Map<string, string>();

/**
 * Remembers the local bytes of a file just uploaded as an attachment. A preview
 * is only a nicety, so a browser that cannot make one leaves the embed waiting
 * on its token instead of failing the upload.
 */
export const rememberPreview = (attachmentId: string, file: File): void => {
  if (previews.has(attachmentId)) return;
  if (typeof URL.createObjectURL !== 'function') return;
  try {
    previews.set(attachmentId, URL.createObjectURL(file));
  } catch {
    return;
  }
};

/** The media context the nearest provider holds. */
export const useMedia = (): MediaContextValue => useContext(MediaContext);

/**
 * The URL an embed or content link loads, preferring a signed URL and falling
 * back to a local preview, or null while neither is available.
 */
export const useMediaUrl = (src: string): string | null => {
  const { tokens } = useMedia();
  const resolved = resolveMediaUrl(src, tokens);
  if (resolved !== null) return resolved;
  const attachmentId = attachmentIdOf(src);
  return attachmentId === null ? null : (previews.get(attachmentId) ?? null);
};
