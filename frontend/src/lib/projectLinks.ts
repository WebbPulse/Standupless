/**
 * Pure helpers over a project's Resources links: which typed addresses are
 * taken, how one is completed the way a browser would, and what a link reads
 * as. Kept apart from the section so the component file exports only
 * components and the rules are tested on their own.
 */

import type { ProjectLinkRead } from '../types/Api';

/** The parsed URL when it is a web address with a host, otherwise null. */
export const webUrl = (value: string): URL | null => {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname === '' ? null : url;
  } catch {
    return null;
  }
};

/** What a link reads as: its title, or its hostname when it has none. */
export const linkLabel = (
  link: Pick<ProjectLinkRead, 'url' | 'title'>
): string => {
  const title = (link.title ?? '').trim();
  if (title !== '') return title;
  return webUrl(link.url)?.hostname ?? link.url;
};

/**
 * The URL a typed address becomes: as typed when it names a scheme, otherwise
 * with https in front, so "example.com/spec" is taken the way a browser would.
 */
export const normalisedUrl = (value: string): string => {
  const trimmed = value.trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
};
