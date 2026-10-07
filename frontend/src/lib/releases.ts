/**
 * Display helpers for releases: the label for what reported one, the short
 * form of a commit sha, the GitHub links a repository and sha make, and the
 * issue references a free text field names.
 */

const SOURCE_LABELS: Record<string, string> = {
  github_deployment: 'GitHub deployment',
  api: 'API',
  manual: 'Manual',
};

const REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const SHA_PATTERN = /^[0-9a-f]{4,64}$/i;

/** The label for what reported a release or a stage. */
export const releaseSourceLabel = (source: string): string =>
  SOURCE_LABELS[source] ?? source;

/** The seven character form of a commit sha. */
export const shortSha = (sha: string): string => sha.slice(0, 7);

/** Whether a repository reads as a GitHub `owner/name`. */
export const isGithubRepository = (
  repository: string | null | undefined
): repository is string =>
  typeof repository === 'string' && REPOSITORY_PATTERN.test(repository);

/** The GitHub commit page for a sha, or null when either part is unusable. */
export const githubCommitUrl = (
  repository: string | null | undefined,
  sha: string | null | undefined
): string | null => {
  if (!isGithubRepository(repository) || !sha || !SHA_PATTERN.test(sha)) {
    return null;
  }
  return `https://github.com/${repository}/commit/${sha}`;
};

/** The GitHub compare page between two shas, or null when any part is unusable. */
export const githubCompareUrl = (
  repository: string | null | undefined,
  previousSha: string | null | undefined,
  sha: string | null | undefined
): string | null => {
  if (
    !isGithubRepository(repository) ||
    !previousSha ||
    !sha ||
    !SHA_PATTERN.test(previousSha) ||
    !SHA_PATTERN.test(sha)
  ) {
    return null;
  }
  return `https://github.com/${repository}/compare/${previousSha}...${sha}`;
};

/** The distinct issue references a field names, split on commas and spaces. */
export const parseIssueRefs = (text: string): string[] => {
  const refs: string[] = [];
  for (const part of text.split(/[\s,]+/)) {
    const ref = part.trim();
    if (ref !== '' && !refs.includes(ref)) {
      refs.push(ref);
    }
  }
  return refs;
};

/** Whether a url is safe to link to: http or https only. */
export const isLinkableUrl = (url: string | null | undefined): url is string =>
  typeof url === 'string' && /^https?:\/\//i.test(url);
