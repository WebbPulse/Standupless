/**
 * Figma file and frame links that embed as a live preview, as Linear has
 * them. Only an https link to figma.com in a shape Figma publishes parses: a
 * design, file, prototype or FigJam board, with its frame kept from
 * `node-id`. The link is rebuilt from the checked file key and node id alone
 * and handed to Figma's public embed address, so no Figma token or integration
 * is involved and a viewer without access sees Figma's own sign-in or
 * permission screen inside the frame.
 */

/** The Figma link kinds that embed. */
export type FigmaKind = 'file' | 'design' | 'proto' | 'board';

/** A parsed Figma link and the embed address built from it. */
export interface FigmaEmbedTarget {
  /** The file key, checked against its shape. */
  id: string;
  kind: FigmaKind;
  /** The frame the link points at, in Figma's `12-34` form, or null. */
  nodeId: string | null;
  /** The canonical link the embed address is built from. */
  canonicalUrl: string;
  /** Figma's public embed address for the canonical link. */
  embedUrl: string;
}

/** The embed origin the frontend Content-Security-Policy frame-src allows. */
export const FIGMA_EMBED_ORIGIN = 'https://www.figma.com';

const KINDS: readonly FigmaKind[] = ['file', 'design', 'proto', 'board'];
const FILE_KEY = /^[A-Za-z0-9]{10,128}$/;
const NODE_ID = /^(\d{1,12})[-:](\d{1,12})$/;

/** Whether a path segment is a known Figma link kind. */
const isKind = (value: string | undefined): value is FigmaKind =>
  value !== undefined && (KINDS as readonly string[]).includes(value);

/**
 * Parses a Figma link into its embed target, or null when it is not an https
 * figma.com link to a file, design, prototype or board. An odd `node-id`
 * drops to the whole file rather than reaching the embed address.
 */
export const parseFigmaLink = (url: URL): FigmaEmbedTarget | null => {
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '' || url.port !== '') {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'figma.com' && host !== 'www.figma.com') return null;
  const [kind, id] = url.pathname.split('/').filter((part) => part !== '');
  if (!isKind(kind) || id === undefined || !FILE_KEY.test(id)) return null;
  const node = NODE_ID.exec(url.searchParams.get('node-id') ?? '');
  const nodeId = node === null ? null : `${node[1] ?? ''}-${node[2] ?? ''}`;
  const query = nodeId === null ? '' : `?node-id=${nodeId}`;
  const canonicalUrl = `${FIGMA_EMBED_ORIGIN}/${kind}/${id}${query}`;
  return {
    id,
    kind,
    nodeId,
    canonicalUrl,
    embedUrl: `${FIGMA_EMBED_ORIGIN}/embed?embed_host=standupless&url=${encodeURIComponent(canonicalUrl)}`,
  };
};
