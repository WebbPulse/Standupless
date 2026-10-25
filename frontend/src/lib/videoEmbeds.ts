/**
 * The links that embed as a player or preview: YouTube, Loom, Vimeo and
 * Descript videos, and Figma files and frames (see figmaEmbeds.ts). A pasted
 * link is parsed against each provider's known shapes, and the player address
 * is rebuilt from the checked ids alone, so nothing else from the pasted
 * string ever reaches an iframe. Anything else stays a link.
 *
 * The stored form of an embed is its link alone on a line, the same text the
 * static renderer, the editor, GitHub and email read.
 */

import { FIGMA_EMBED_ORIGIN, parseFigmaLink } from './figmaEmbeds';

/** The providers whose links embed. */
export type VideoProvider = 'youtube' | 'loom' | 'vimeo' | 'descript' | 'figma';

/** A parsed video link and the player address built from it. */
export interface VideoEmbed {
  provider: VideoProvider;
  /** The provider's video id, checked against its id shape. */
  id: string;
  /** The link as written, which is what the document stores. */
  url: string;
  /** The player address, built only from the provider origin and the id. */
  embedUrl: string;
}

/** The provider names shown to readers. */
export const VIDEO_PROVIDER_LABELS: Record<VideoProvider, string> = {
  youtube: 'YouTube',
  loom: 'Loom',
  vimeo: 'Vimeo',
  descript: 'Descript',
  figma: 'Figma',
};

/** The player origins the frontend Content-Security-Policy frame-src allows. */
export const VIDEO_EMBED_ORIGINS = [
  'https://www.youtube-nocookie.com',
  'https://www.loom.com',
  'https://player.vimeo.com',
  'https://share.descript.com',
  FIGMA_EMBED_ORIGIN,
] as const;

/** A bare web address that could be a video link, alone on its line. */
export const BARE_VIDEO_LINE = /^ {0,3}(https?:\/\/\S+)[ \t]*$/;

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const LOOM_ID = /^[0-9a-f]{32}$/;
const VIMEO_ID = /^\d{1,12}$/;
const VIMEO_HASH = /^[0-9a-f]{6,20}$/;
const DESCRIPT_ID = /^[A-Za-z0-9]{6,32}$/;
const TIME = /^(?:(\d{1,2})h)?(?:(\d{1,3})m)?(?:(\d{1,5})s?)?$/;

/** A YouTube `t` or `start` value in whole seconds, or null when absent or odd. */
const startSeconds = (value: string | null): number | null => {
  if (value === null || value === '') return null;
  const found = TIME.exec(value);
  if (found === null) return null;
  const [, hours, minutes, seconds] = found;
  const total =
    Number(hours ?? 0) * 3600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0);
  return total > 0 ? total : null;
};

/** The path's segments, without empty ones. */
const segments = (url: URL): string[] =>
  url.pathname.split('/').filter((part) => part !== '');

/** A YouTube watch, short, live, embed or youtu.be link. */
const youtube = (url: URL, host: string): Omit<VideoEmbed, 'url'> | null => {
  const parts = segments(url);
  let id: string | null = null;
  if (host === 'youtu.be') {
    id = parts.length === 1 ? (parts[0] ?? null) : null;
  } else if (
    ['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)
  ) {
    if (parts.length === 1 && parts[0] === 'watch')
      id = url.searchParams.get('v');
    else if (
      parts.length === 2 &&
      ['shorts', 'live', 'embed'].includes(parts[0] ?? '')
    ) {
      id = parts[1] ?? null;
    }
  } else {
    return null;
  }
  if (id === null || !YOUTUBE_ID.test(id)) return null;
  const start = startSeconds(
    url.searchParams.get('t') ?? url.searchParams.get('start')
  );
  const query = start === null ? '' : `?start=${String(start)}`;
  return {
    provider: 'youtube',
    id,
    embedUrl: `https://www.youtube-nocookie.com/embed/${id}${query}`,
  };
};

/** A Loom share or embed link. */
const loom = (url: URL, host: string): Omit<VideoEmbed, 'url'> | null => {
  if (host !== 'loom.com') return null;
  const [kind, id, ...rest] = segments(url);
  if (rest.length > 0 || !['share', 'embed'].includes(kind ?? '')) return null;
  if (id === undefined || !LOOM_ID.test(id)) return null;
  return { provider: 'loom', id, embedUrl: `https://www.loom.com/embed/${id}` };
};

/** A Vimeo video link, public or unlisted, or a player link. */
const vimeo = (url: URL, host: string): Omit<VideoEmbed, 'url'> | null => {
  const parts = segments(url);
  let id: string | undefined;
  let hash: string | null;
  if (host === 'vimeo.com') {
    if (parts.length < 1 || parts.length > 2) return null;
    [id] = parts;
    hash = parts[1] ?? url.searchParams.get('h');
  } else if (host === 'player.vimeo.com') {
    if (parts.length !== 2 || parts[0] !== 'video') return null;
    id = parts[1];
    hash = url.searchParams.get('h');
  } else {
    return null;
  }
  if (id === undefined || !VIMEO_ID.test(id)) return null;
  if (hash !== null && !VIMEO_HASH.test(hash)) return null;
  const query = hash === null ? '' : `?h=${hash}`;
  return {
    provider: 'vimeo',
    id,
    embedUrl: `https://player.vimeo.com/video/${id}${query}`,
  };
};

/** A Descript share link. */
const descript = (url: URL, host: string): Omit<VideoEmbed, 'url'> | null => {
  if (host !== 'share.descript.com') return null;
  const [kind, id, ...rest] = segments(url);
  if (rest.length > 0 || !['view', 'embed'].includes(kind ?? '')) return null;
  if (id === undefined || !DESCRIPT_ID.test(id)) return null;
  return {
    provider: 'descript',
    id,
    embedUrl: `https://share.descript.com/embed/${id}`,
  };
};

/** A Figma file, design, prototype or board link. */
const figma = (url: URL): Omit<VideoEmbed, 'url'> | null => {
  const found = parseFigmaLink(url);
  return found === null
    ? null
    : { provider: 'figma', id: found.id, embedUrl: found.embedUrl };
};

/**
 * Parses a link into what it embeds, or null when it is not a link to one of
 * the providers in a shape they publish.
 */
export const parseVideoEmbed = (raw: string): VideoEmbed | null => {
  const text = raw.trim();
  if (text === '' || /\s/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '' || url.port !== '') {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const found =
    youtube(url, host) ??
    loom(url, host) ??
    vimeo(url, host) ??
    descript(url, host) ??
    figma(url);
  return found === null ? null : { ...found, url: text };
};

/** The video a line of Markdown embeds, when the line is a bare video link. */
export const videoEmbedOfLine = (line: string): VideoEmbed | null => {
  const found = BARE_VIDEO_LINE.exec(line);
  return found === null ? null : parseVideoEmbed(found[1] ?? '');
};
