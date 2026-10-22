/**
 * Files added to an issue that does not exist yet. An attachment belongs to an
 * issue, so the new issue dialog holds each pasted, dropped or picked file and
 * writes a placeholder reference into the description where it went. Once the
 * issue is created the files upload to it and each placeholder becomes the
 * stored content path, written in the same Markdown the issue page writes: an
 * image or video as an embed, any other file as a link.
 */

import { mediaKindOf } from './media';

/** The target a placeholder reference points at until its file lands. */
const PENDING_SCHEME = 'pending-upload:';

/** Every placeholder reference in a body, with its name and local id. */
const PENDING_PATTERN = /!?\[([^\]]*)\]\(pending-upload:([A-Za-z0-9-]+)\)/g;

/** A file name with the characters Markdown link text cannot hold removed. */
const linkText = (name: string): string =>
  name.replace(/[[\]()\\]/g, '').trim() || 'file';

/** The Markdown placeholder for one held file. */
export const pendingReference = (id: string, file: File): string => {
  const text = linkText(file.name);
  const embed = mediaKindOf(file.type) !== null ? '!' : '';
  return `${embed}[${text}](${PENDING_SCHEME}${id})`;
};

/** Whether a body still names the held file with this id. */
export const namesPending = (body: string, id: string): boolean =>
  body.includes(`(${PENDING_SCHEME}${id})`);

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
    .replace(PENDING_PATTERN, (whole: string, _text: string, id: string) => {
      const path = pathOf(id);
      return path === null
        ? ''
        : whole.replace(`(${PENDING_SCHEME}${id})`, `(${path})`);
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
