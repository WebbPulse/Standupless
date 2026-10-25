/**
 * The custom emoji routes: a workspace's own emoji, added from an uploaded
 * image and used as a `:name:` shortcode in text and reactions. Any member
 * reads and adds them; the uploader or a workspace admin deletes one. The
 * image bytes go straight to the bucket between signing and naming, as an
 * icon's do, and the server resizes them.
 */

import apiClient from './client';
import { putUploadBytes } from './discussion';
import type {
  CustomEmojiCreate,
  CustomEmojiListRead,
  CustomEmojiRead,
  IconUploadCreate,
  IconUploadRead,
} from '../types/Api';

/** The image types a custom emoji may be. */
export const CUSTOM_EMOJI_CONTENT_TYPES: string[] = [
  'image/png',
  'image/gif',
  'image/webp',
];

/** The largest custom emoji image the presign route signs, in bytes. */
export const MAX_CUSTOM_EMOJI_BYTES = 1024 * 1024;

/** The shape a custom emoji name must have, as the server holds it. */
export const CUSTOM_EMOJI_NAME = /^[a-z0-9][a-z0-9_-]{1,31}$/;

/** The route a workspace's custom emoji are read and added through. */
export const customEmojiPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/emoji`;

/** Why this file cannot be a custom emoji, or null when the server would sign it. */
export const describeCustomEmojiRefusal = (file: File): string | null => {
  if (!CUSTOM_EMOJI_CONTENT_TYPES.includes(file.type.toLowerCase())) {
    return 'Choose a PNG, GIF or WebP image.';
  }
  if (file.size > MAX_CUSTOM_EMOJI_BYTES) {
    return 'Choose an image of 1 MB or less.';
  }
  return null;
};

/** Lists the workspace's custom emoji, in name order. */
export const listCustomEmoji = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<CustomEmojiRead[]> => {
  const response = await apiClient.get<CustomEmojiListRead>(
    customEmojiPath(workspaceId),
    signal === undefined ? undefined : { signal }
  );
  const body = response.data;
  return Array.isArray(body?.emoji) ? body.emoji : [];
};

/** Signs a PUT for one custom emoji image. */
export const createCustomEmojiUpload = async (
  workspaceId: string,
  body: IconUploadCreate
): Promise<IconUploadRead> =>
  (
    await apiClient.post<IconUploadRead>(
      `${customEmojiPath(workspaceId)}/uploads`,
      body
    )
  ).data;

/** Names an uploaded image as a custom emoji; a taken name answers 409. */
export const createCustomEmoji = async (
  workspaceId: string,
  body: CustomEmojiCreate
): Promise<CustomEmojiRead> =>
  (await apiClient.post<CustomEmojiRead>(customEmojiPath(workspaceId), body))
    .data;

/** Deletes one custom emoji; text that used it keeps its `:name:`. */
export const deleteCustomEmoji = async (
  workspaceId: string,
  name: string
): Promise<void> => {
  await apiClient.delete(
    `${customEmojiPath(workspaceId)}/${encodeURIComponent(name)}`
  );
};

/** Uploads one image and names it: sign, PUT the bytes, then create. */
export const uploadCustomEmoji = async (
  workspaceId: string,
  name: string,
  file: File
): Promise<CustomEmojiRead> => {
  const upload = await createCustomEmojiUpload(workspaceId, {
    content_type: file.type,
    size_bytes: file.size,
  });
  await putUploadBytes(upload, file);
  return createCustomEmoji(workspaceId, { name, upload_id: upload.upload_id });
};
