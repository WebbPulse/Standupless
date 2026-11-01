/**
 * Files added to an issue that does not exist yet. An attachment belongs to an
 * issue, so the new issue dialog holds each pasted, dropped or picked file and
 * writes a placeholder content path into the description where it went: an
 * image or video as an embed, any other file as a link. The placeholder names
 * a stand in attachment of a stand in issue, so the editor draws it like any
 * other embed, from the local preview of the held bytes. Once the issue is
 * created the files upload to it and each placeholder becomes the stored
 * content path, written in the same Markdown the issue page writes.
 */

import { ApiError } from '@webbpulse/api-client';
import { contentPath, mediaKindOf, type MediaKind } from './media';

/** The stand in issue id a placeholder path names. */
const PENDING_ISSUE = 'pending-upload';

/** The prefix of the stand in attachment id a placeholder path names. */
const PENDING_PREFIX = 'pending-';

/** Every placeholder reference in a body, with its target and local id. */
const PENDING_PATTERN =
  /!?\[(?:\\.|[^\]\\])*\]\((\/api\/workspaces\/[A-Za-z0-9_-]{1,64}\/attachments\/pending-([A-Za-z0-9-]{1,56})\/content\?issue_id=pending-upload(?:&media=video)?)\)/g;

/** The stand in attachment id of one held file, for its local preview. */
export const pendingAttachmentId = (id: string): string =>
  `${PENDING_PREFIX}${id}`;

/** The placeholder content path of one held file. */
export const pendingPath = (
  workspaceId: string,
  id: string,
  kind: MediaKind | null
): string =>
  contentPath(workspaceId, pendingAttachmentId(id), PENDING_ISSUE, kind);

/** Whether a body holds any placeholder at all. */
export const hasPending = (body: string): boolean =>
  body.includes(`?issue_id=${PENDING_ISSUE}`);

/** Whether a body still names the held file with this id. */
export const namesPending = (body: string, id: string): boolean =>
  body.includes(
    `/attachments/${pendingAttachmentId(id)}/content?issue_id=${PENDING_ISSUE}`
  );

/** The body with every placeholder reference taken out. */
export const stripPending = (body: string): string =>
  resolvePending(body, () => null);

/**
 * The body with each placeholder replaced by the path its file landed at, and
 * the ones whose file did not land taken out.
 */
export const resolvePending = (
  body: string,
  pathOf: (id: string) => string | null
): string =>
  body
    .replace(PENDING_PATTERN, (whole: string, target: string, id: string) => {
      const path = pathOf(id);
      return path === null ? '' : whole.replace(`(${target})`, `(${path})`);
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * The body with a placeholder added at the end for each held file it no longer
 * names, so a file shown as attached always lands in the description.
 */
export const withHeldReferences = (
  body: string,
  workspaceId: string,
  held: readonly { id: string; file: File }[]
): string =>
  held
    .filter((item) => !namesPending(body, item.id))
    .map((item) => pendingReference(workspaceId, item.id, item.file))
    .reduce(
      (text, reference) =>
        text.trim() === '' ? reference : `${text}\n\n${reference}`,
      body
    );

/** How long to wait before each further try at a held file's request. */
const HELD_RETRY_DELAYS_MS = [1_000, 3_000];

/**
 * Runs one request of a held file's upload, trying again when the connection
 * or the server failed rather than the request being refused, because the
 * dialog is about to close and nothing can resend it after that.
 */
export const retryHeldRequest = async <T>(
  request: () => Promise<T>,
  delays: readonly number[] = HELD_RETRY_DELAYS_MS
): Promise<T> => {
  try {
    return await request();
  } catch (failure: unknown) {
    const [delay, ...rest] = delays;
    const refused =
      failure instanceof ApiError &&
      failure.status >= 400 &&
      failure.status < 500;
    if (refused || delay === undefined) throw failure;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return retryHeldRequest(request, rest);
  }
};

/** The Markdown placeholder for one held file, as the editor writes it. */
export const pendingReference = (
  workspaceId: string,
  id: string,
  file: File
): string => {
  const kind = mediaKindOf(file.type);
  const text = file.name.replace(/[[\]()\\]/g, '').trim() || 'file';
  return `${kind === null ? '' : '!'}[${text}](${pendingPath(workspaceId, id, kind)})`;
};
