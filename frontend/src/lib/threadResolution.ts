/**
 * What a resolved thread's one-line summary says: a plain excerpt of the
 * thread's first comment and a count of its replies. Kept out of the card so a
 * component file exports only components, and so the wording is tested once.
 */

const EXCERPT_LIMIT = 120;

/**
 * The first line of a comment as plain text, with Markdown's link, image,
 * emphasis and heading syntax removed, so a summary row reads as a sentence.
 */
export const commentExcerpt = (body: string): string => {
  const text = body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/, '')
        .replace(/[*_~`]/g, '')
        .trim()
    )
    .find((line) => line !== '');
  if (text === undefined) return '';
  return text.length > EXCERPT_LIMIT
    ? `${text.slice(0, EXCERPT_LIMIT - 1).trimEnd()}…`
    : text;
};

/** "1 reply" or "N replies", or empty for a thread nobody answered. */
export const replyCountLabel = (count: number): string => {
  if (count <= 0) return '';
  return count === 1 ? '1 reply' : `${count} replies`;
};
