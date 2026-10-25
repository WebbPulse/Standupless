/**
 * The `#` reference picker behind every rich editor, and the links it writes.
 * Typing `#` after whitespace, or a team's key such as `ENG-12`, asks search
 * for the issues, projects and documents the writer can see, and for the pull
 * requests linked to issues they can see. Picking an issue writes its key,
 * which every reader already knows; picking a project or a document writes a
 * Markdown link to its page, and picking a pull request writes a Markdown link
 * to it on GitHub, each named after what it points at, so GitHub, email and
 * the share view still read a working link while the app draws it as a chip.
 */

import type {
  PullRequestHitRead,
  SearchListRead,
  SearchResultRead,
  StatusCategory,
} from '../types/Api';
import { isTeamKey } from './issueDisplay';
import { idFromReadable, readableId } from './readableIds';

/** The reference being typed: where its trigger starts and what follows it. */
export interface ReferenceQuery {
  start: number;
  query: string;
  trigger: 'hash' | 'key';
}

/** One issue the picker offers, with what its status glyph needs. */
export interface IssueReference {
  kind: 'issue';
  id: string;
  key: string;
  title: string;
  statusName: string | null;
  statusCategory: StatusCategory | null;
  statusColor: string | null;
  statusIcon: string | null;
}

/** One project the picker offers. */
export interface ProjectReference {
  kind: 'project';
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
}

/** One document the picker offers, with where it lives. */
export interface DocumentReference {
  kind: 'document';
  id: string;
  title: string;
  parentName: string;
}

/** One linked pull request the picker offers, with its state for the glyph. */
export interface PullRequestReference {
  kind: 'pull_request';
  id: string;
  title: string;
  url: string;
  repository: string;
  number: number;
  state: PullRequestHitRead['state'];
}

/** Anything the picker can insert. */
export type ReferenceItem =
  IssueReference | ProjectReference | DocumentReference | PullRequestReference;

/** A project or document named by a link to its page. */
export interface LinkedReference {
  kind: 'project' | 'document';
  slug: string;
  id: string;
}

/** The fewest characters search reads a free text word from. */
export const REFERENCE_QUERY_MIN = 2;

/** How many hits of each kind the picker shows. */
export const REFERENCE_LIMITS = {
  issue: 6,
  project: 3,
  document: 3,
  pull_request: 3,
} as const;

/** A team key being typed, such as `ENG-` or `ENG-12`. */
const TYPED_KEY = /(^|\s)([A-Z][A-Z0-9]{1,5}-\d*)$/;

/**
 * A `#` reference being typed, which may not hold whitespace. Another `#` may
 * only follow a repository and lead its pull request number, as in
 * `#acme/app#12`, so a heading's `##` never opens the picker.
 */
const TYPED_HASH = /(^|\s)#([^\s#]+#\d*|[^\s#]*)$/;

/** A GitHub pull request address, such as `https://github.com/acme/app/pull/12`. */
const PULL_REQUEST_LINK =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?(?:[?#].*)?$/i;

/** A page link a project or document reference writes. */
const PAGE_LINK =
  /^(https?:\/\/[^/?#]+)\/w\/([^/?#]+)\/(projects|documents)\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/;

/**
 * The reference the caret is in, or null. A `#` must start the text or follow
 * whitespace, so a heading or an anchor in a URL never opens the picker, and a
 * bare key opens it only when its prefix is one of the given teams.
 */
export const referenceQuery = (
  text: string,
  caret: number,
  teams: readonly { key_prefix: string; retired_key_prefixes?: string[] }[] = []
): ReferenceQuery | null => {
  const before = text.slice(0, caret);
  const hash = TYPED_HASH.exec(before);
  if (hash !== null) {
    const query = hash[2] ?? '';
    return { start: caret - query.length - 1, query, trigger: 'hash' };
  }
  const key = TYPED_KEY.exec(before);
  const typed = key?.[2];
  if (typed === undefined || !isTeamKey(`${typed}0`, teams)) return null;
  return { start: caret - typed.length, query: typed, trigger: 'key' };
};

/** Whether a query is shaped like a full issue key, which search looks up exactly. */
export const isKeyQuery = (query: string): boolean =>
  /^[A-Za-z][A-Za-z0-9]{1,5}-\d+$/.test(query);

/**
 * Whether a query names a pull request by number, such as `42` or
 * `acme/app#42`, which the linked pull request search answers however short.
 */
export const isPullRequestQuery = (query: string): boolean =>
  /^(?:(?:[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+#)?\d+$/.test(query.trim());

/** Whether search can answer the query, so a too short one costs no request. */
export const isSearchable = (query: string): boolean =>
  isKeyQuery(query.trim()) ||
  isPullRequestQuery(query) ||
  (!/^[A-Za-z][A-Za-z0-9]*-$/.test(query.trim()) &&
    query
      .trim()
      .split(/[^A-Za-z0-9]+/)
      .some((term) => term.length >= REFERENCE_QUERY_MIN));

/** One issue hit as the picker offers it. */
const issueItem = (hit: SearchResultRead): IssueReference => ({
  kind: 'issue',
  id: hit.issue_id,
  key: hit.key,
  title: hit.title,
  statusName: hit.status_name ?? null,
  statusCategory: hit.status_category ?? null,
  statusColor: hit.status_color ?? null,
  statusIcon: hit.status_icon ?? null,
});

/** One linked pull request hit as the picker offers it. */
export const pullRequestItem = (
  hit: PullRequestHitRead
): PullRequestReference => ({
  kind: 'pull_request',
  id: `${hit.repository_full_name}#${String(hit.number)}`,
  title: hit.title,
  url: hit.url,
  repository: hit.repository_full_name,
  number: hit.number,
  state: hit.state,
});

/**
 * The search answer as the picker lists it: issues first, then projects, then
 * documents, then linked pull requests, each capped so one kind cannot crowd
 * out the others and a pull request never outranks an issue.
 */
export const referenceItems = (
  answer: Partial<SearchListRead>,
  pullRequests: readonly PullRequestHitRead[] = []
): ReferenceItem[] => [
  ...(answer.results ?? []).slice(0, REFERENCE_LIMITS.issue).map(issueItem),
  ...(answer.projects ?? [])
    .slice(0, REFERENCE_LIMITS.project)
    .map((project): ProjectReference => ({
      kind: 'project',
      id: project.project_id,
      name: project.name,
      icon: project.icon,
      color: project.color,
    })),
  ...(answer.documents ?? [])
    .slice(0, REFERENCE_LIMITS.document)
    .map((document): DocumentReference => ({
      kind: 'document',
      id: document.document_id,
      title: document.title,
      parentName: document.parent_name,
    })),
  ...pullRequests.slice(0, REFERENCE_LIMITS.pull_request).map(pullRequestItem),
];

/** The absolute address of a project's or document's page. */
export const referenceHref = (
  origin: string,
  slug: string,
  item: ProjectReference | DocumentReference
): string =>
  item.kind === 'project'
    ? `${origin}/w/${slug}/projects/${readableId(item.id, item.name)}`
    : `${origin}/w/${slug}/documents/${item.id}`;

/** The name a reference is written and shown under. */
export const referenceLabel = (item: ReferenceItem): string => {
  switch (item.kind) {
    case 'issue':
      return item.key;
    case 'project':
      return item.name;
    case 'document':
    case 'pull_request':
      return item.title;
  }
};

/** Escapes the characters that would end a Markdown link's text early. */
const escapeLinkText = (text: string): string =>
  text.replace(/[\\[\]]/g, (char) => `\\${char}`);

/** Where a picked project, document or pull request link points. */
export const referenceLinkHref = (
  item: ProjectReference | DocumentReference | PullRequestReference,
  origin: string,
  slug: string
): string =>
  item.kind === 'pull_request' ? item.url : referenceHref(origin, slug, item);

/**
 * The Markdown a picked reference writes: an issue's key, or a link named
 * after the project, document or pull request that points at its page.
 */
export const referenceMarkdown = (
  item: ReferenceItem,
  origin: string,
  slug: string
): string =>
  item.kind === 'issue'
    ? item.key
    : `[${escapeLinkText(referenceLabel(item))}](${referenceLinkHref(item, origin, slug)})`;

/** A GitHub pull request a link points at. */
export interface LinkedPullRequest {
  repository: string;
  number: number;
}

/** The GitHub pull request a link points at, or null for any other link. */
export const linkedPullRequest = (href: string): LinkedPullRequest | null => {
  const match = PULL_REQUEST_LINK.exec(href.trim());
  if (match === null) return null;
  const [, owner, repo, number] = match;
  if (owner === undefined || repo === undefined || number === undefined) {
    return null;
  }
  return { repository: `${owner}/${repo}`, number: Number(number) };
};

/**
 * The project or document a link points at, or null. Only a page of this
 * origin counts, so a link to another deployment stays an ordinary link.
 */
export const linkedReference = (
  href: string,
  origin: string
): LinkedReference | null => {
  const match = PAGE_LINK.exec(href.trim());
  if (match === null) return null;
  const [, host, slug, collection, id] = match;
  if (host === undefined || slug === undefined || id === undefined) return null;
  if (host.toLowerCase() !== origin.toLowerCase()) return null;
  return {
    kind: collection === 'projects' ? 'project' : 'document',
    slug: decodeURIComponent(slug),
    id: collection === 'projects' ? idFromReadable(id) : id,
  };
};

/** The page's own origin, or the empty string where there is no window. */
export const currentOrigin = (): string =>
  typeof window === 'undefined' ? '' : window.location.origin;
