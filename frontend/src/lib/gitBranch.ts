/**
 * The git branch name an issue suggests: its key and title, lowercased and
 * joined by hyphens, so a branch cut from it links back to the issue the
 * moment it is pushed (the key is what the GitHub link matcher looks for).
 */

/** The longest branch name suggested, so a long title stays readable. */
export const BRANCH_MAX = 60;

/** Builds the suggested branch name, such as `ghs-1-fix-login`. */
export const gitBranchName = (issueKey: string, title: string): string => {
  const key = issueKey.toLowerCase();
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug === '') return key;
  const room = BRANCH_MAX - key.length - 1;
  const trimmed = slug.slice(0, room).replace(/-+$/, '');
  return trimmed === '' ? key : `${key}-${trimmed}`;
};
