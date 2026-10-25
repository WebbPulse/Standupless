/**
 * A document's outline: its H1 to H3 headings in reading order, read from the
 * Markdown. Each entry keeps its position among the rendered headings, so the
 * page can scroll to the matching element without giving headings ids.
 */

/** One heading in the outline. */
export interface OutlineEntry {
  /** 1, 2 or 3, from the number of `#` marks. */
  level: number;
  /** The heading as it reads, without its inline Markdown. */
  text: string;
  /** Its position among the document's H1 to H3 headings. */
  index: number;
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The text a heading line reads as, without links, emphasis or code marks. */
const plain = (source: string): string =>
  source
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, '$1$2')
    .trim();

/** The H1 to H3 headings of a Markdown document, skipping fenced code. */
export const outlineOf = (markdown: string): OutlineEntry[] => {
  const entries: OutlineEntry[] = [];
  let fence: string | null = null;
  for (const line of markdown.split('\n')) {
    const opener = FENCE.exec(line);
    if (opener !== null) {
      const mark = opener[1] ?? '';
      if (fence === null) fence = mark.charAt(0).repeat(3);
      else if (mark.startsWith(fence)) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const match = HEADING.exec(line);
    if (match === null) continue;
    const level = (match[1] ?? '').length;
    if (level > 3) continue;
    const text = plain(match[2] ?? '');
    if (text === '') continue;
    entries.push({ level, text, index: entries.length });
  }
  return entries;
};
