/**
 * Readable, durable path segments for projects and initiatives.
 *
 * A segment is `<name-slug>-<ULID>`: the slug tells a reader what the link is
 * and the ULID is what resolves it, so a link keeps working after a rename.
 * The backend's `app.common.readable_ids` mirrors these rules exactly.
 */

/** The longest slug a segment carries, before the id. */
export const SLUG_MAX_LENGTH = 60;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const TRAILING_ULID = /(?:^|-)([0-9A-HJKMNP-TV-Z]{26})$/i;

/** Whether a value is a ULID, the only kind of id a slug is put in front of. */
export const isUlid = (value: string): boolean => ULID.test(value);

/**
 * A name as lowercase ASCII kebab-case of at most 60 characters. Accents fold
 * to their base letters, anything else outside ASCII letters and digits
 * becomes a separator, and a name with nothing left gives an empty slug.
 */
export const nameSlug = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/[^\p{ASCII}]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, '');

/**
 * The path segment for an entity: `<slug>-<id>`, or the bare id when the name
 * slugs to nothing or the id is not a ULID a reader could pick back out.
 */
export const readableId = (
  id: string,
  name: string | null | undefined
): string => {
  const slug = name === null || name === undefined ? '' : nameSlug(name);
  return slug === '' || !isUlid(id) ? id : `${slug}-${id}`;
};

/**
 * The entity id a path segment names: the ULID at its end, whatever slug comes
 * before it, or the whole segment when it ends in no ULID.
 */
export const idFromReadable = (segment: string): string =>
  TRAILING_ULID.exec(segment)?.[1] ?? segment;
