/**
 * The git branch name an issue suggests, built in the workspace's chosen
 * format: its key and title, the copier's handle then a slash then the key and
 * title, or the key alone, as Linear's GitHub settings offer. Every format keeps
 * the key whole, so a branch cut from it links back to the issue the moment it
 * is pushed (the key is what the GitHub link matcher looks for).
 *
 * Keep this in step with `cli/src/standupless_cli/branch.py`; both are held to
 * `cli/tests/fixtures/branch_names.json`.
 */

import type { BranchFormat } from '../types/Api';

export type { BranchFormat };

/** The longest branch name suggested, so a long title stays readable. */
export const BRANCH_MAX = 60;

/** The format a workspace starts with, the one used before any was chosen. */
export const DEFAULT_BRANCH_FORMAT: BranchFormat = 'key_title';

/** Every format with how it reads in settings, in the order offered. */
export const BRANCH_FORMATS: readonly { value: BranchFormat; label: string }[] =
  [
    { value: 'key_title', label: 'Identifier and title' },
    { value: 'user_key_title', label: 'Username, identifier and title' },
    { value: 'key', label: 'Identifier only' },
  ];

/** What a branch name is built from besides the issue: the format and the copier's handle. */
export interface BranchNaming {
  format: BranchFormat;
  handle: string;
}

/** Folds accents away, lowercases, and collapses everything else into single hyphens. */
export const slugify = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Cuts `text` to `room` characters without leaving a trailing hyphen. */
const trim = (text: string, room: number): string =>
  text.slice(0, Math.max(room, 0)).replace(/-+$/, '');

/**
 * Builds the suggested branch name, such as `ghs-1-fix-login`,
 * `tyler/ghs-1-fix-login` or `ghs-1`. The handle is shortened before the key
 * is ever cut, and a format needing a handle falls back to the key and title
 * when there is none.
 */
export const gitBranchName = (
  issueKey: string,
  title: string,
  naming?: Partial<BranchNaming>
): string => {
  const key = issueKey.toLowerCase();
  const format = naming?.format ?? DEFAULT_BRANCH_FORMAT;
  if (format === 'key') return key;
  const handle =
    format === 'user_key_title'
      ? trim(slugify(naming?.handle ?? ''), BRANCH_MAX - key.length - 1)
      : '';
  const head = handle === '' ? key : `${handle}/${key}`;
  const slug = trim(slugify(title), BRANCH_MAX - head.length - 1);
  return slug === '' ? head : `${head}-${slug}`;
};

/** The handle a person's branches carry: their username, else their email's local part. */
export const branchHandle = (
  person: { display_name?: string | null; email?: string } | undefined
): string => {
  const name = person?.display_name?.trim() ?? '';
  if (name !== '') return name;
  return (person?.email ?? '').split('@')[0] ?? '';
};
