/**
 * A small Markdown parser for issue descriptions and comments. It covers what
 * people write in a tracker (paragraphs, headings, lists and task lists,
 * quotes, fenced code, inline code, emphasis, links and @mentions) and nothing
 * that would need raw HTML: the output is a tree the renderer turns into React
 * elements, so no string from a comment is ever parsed as markup.
 *
 * Link targets are limited to http, https and mailto, so a `javascript:` URL
 * in a comment renders as text rather than as a link.
 */

/** One inline run. */
export type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'link'; href: string; children: InlineNode[] }
  | { type: 'strong' | 'em' | 'del'; children: InlineNode[] }
  | { type: 'mention'; handle: string }
  | { type: 'break' };

/** One list item, with its task state when it is a task. */
export interface ListItem {
  children: InlineNode[];
  checked: boolean | null;
}

/** One block. */
export type BlockNode =
  | { type: 'paragraph'; children: InlineNode[] }
  | { type: 'heading'; level: number; children: InlineNode[] }
  | { type: 'code'; language: string; value: string }
  | { type: 'quote'; children: BlockNode[] }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'rule' };

/** The schemes a link may point at. */
const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** Whether a link target is one the renderer may make clickable. */
export const isSafeUrl = (href: string): boolean => SAFE_URL.test(href.trim());

/**
 * The inline grammar, tried left to right at each position. The groups are,
 * in order: a code span, a link, a bare URL, strong, strong with underscores,
 * strikethrough, emphasis, emphasis with underscores, a mention, and a
 * backslash escape, which the rich editor writes when literal text would
 * otherwise read as formatting.
 */
const INLINE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<]*[^\s<.,:;"')\]!?])|\*\*(\S[\s\S]*?)\*\*|__(\S[\s\S]*?)__|~~(\S[\s\S]*?)~~|\*(\S[\s\S]*?)\*|(?<![\w])_(\S[\s\S]*?)_(?![\w])|(?<![\w@/])@([A-Za-z0-9][A-Za-z0-9_-]{0,38})(?![\w-])|\\([!-/:-@[-`{-~])/g;

/** Appends text, merging it into a text node already at the end. */
const pushText = (out: InlineNode[], value: string): void => {
  if (value === '') return;
  const last = out[out.length - 1];
  if (last?.type === 'text') last.value += value;
  else out.push({ type: 'text', value });
};

/** Splits text on newlines into text and hard breaks. */
const pushLines = (out: InlineNode[], value: string): void => {
  value.split('\n').forEach((line, index) => {
    if (index > 0) out.push({ type: 'break' });
    pushText(out, line);
  });
};

/** Parses one run of inline Markdown. */
export const parseInline = (source: string): InlineNode[] => {
  const out: InlineNode[] = [];
  const pattern = new RegExp(INLINE.source, 'g');
  let cursor = 0;
  let match = pattern.exec(source);
  while (match !== null) {
    pushLines(out, source.slice(cursor, match.index));
    const [
      whole,
      ,
      code,
      linkText,
      linkHref,
      bare,
      strong,
      strongAlt,
      del,
      em,
      emAlt,
      mention,
      escaped,
    ] = match;
    if (code !== undefined) {
      out.push({ type: 'code', value: code });
    } else if (linkText !== undefined && linkHref !== undefined) {
      if (isSafeUrl(linkHref)) {
        out.push({
          type: 'link',
          href: linkHref,
          children: parseInline(linkText),
        });
      } else {
        pushText(out, whole);
      }
    } else if (bare !== undefined) {
      out.push({
        type: 'link',
        href: bare,
        children: [{ type: 'text', value: bare }],
      });
    } else if (strong !== undefined || strongAlt !== undefined) {
      out.push({
        type: 'strong',
        children: parseInline(strong ?? strongAlt ?? ''),
      });
    } else if (del !== undefined) {
      out.push({ type: 'del', children: parseInline(del) });
    } else if (em !== undefined || emAlt !== undefined) {
      out.push({ type: 'em', children: parseInline(em ?? emAlt ?? '') });
    } else if (mention !== undefined) {
      out.push({ type: 'mention', handle: mention });
    } else if (escaped !== undefined) {
      pushText(out, escaped);
    } else {
      pushText(out, whole);
    }
    cursor = match.index + whole.length;
    match = pattern.exec(source);
  }
  pushLines(out, source.slice(cursor));
  return out;
};

const FENCE = /^\s{0,3}(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;

/** Whether a line starts a block other than a paragraph. */
const startsBlock = (line: string): boolean =>
  FENCE.test(line) ||
  HEADING.test(line) ||
  RULE.test(line) ||
  QUOTE.test(line) ||
  BULLET.test(line) ||
  ORDERED.test(line);

/** Builds one list item, reading a leading `[ ]` or `[x]` as a task. */
const listItem = (content: string): ListItem => {
  const task = TASK.exec(content);
  if (task === null) return { children: parseInline(content), checked: null };
  return {
    children: parseInline(task[2] ?? ''),
    checked: (task[1] ?? ' ') !== ' ',
  };
};

/** Parses a whole Markdown document into blocks. */
export const parseMarkdown = (source: string): BlockNode[] => {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: BlockNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[1] ?? '```';
      const body: string[] = [];
      index += 1;
      while (
        index < lines.length &&
        !(lines[index] ?? '').trim().startsWith(marker)
      ) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1;
      blocks.push({
        type: 'code',
        language: fence[2] ?? '',
        value: body.join('\n'),
      });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({
        type: 'heading',
        level: (heading[1] ?? '#').length,
        children: parseInline(heading[2] ?? ''),
      });
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length) {
        const quoted = QUOTE.exec(lines[index] ?? '');
        if (quoted === null) break;
        body.push(quoted[1] ?? '');
        index += 1;
      }
      blocks.push({ type: 'quote', children: parseMarkdown(body.join('\n')) });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet !== null || ordered !== null) {
      const isOrdered = bullet === null;
      const marker = isOrdered ? ORDERED : BULLET;
      const items: ListItem[] = [];
      const pending: string[] = [];
      const flush = (): void => {
        if (pending.length > 0) items.push(listItem(pending.join('\n')));
        pending.length = 0;
      };
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const item = marker.exec(current);
        if (item !== null) {
          flush();
          pending.push((isOrdered ? item[2] : item[1]) ?? '');
        } else if (
          current.trim() !== '' &&
          /^\s+/.test(current) &&
          pending.length > 0
        ) {
          pending.push(current.trim());
        } else {
          break;
        }
        index += 1;
      }
      flush();
      blocks.push({
        type: 'list',
        ordered: isOrdered,
        start: isOrdered ? Number(ordered?.[1] ?? '1') : 1,
        items,
      });
      continue;
    }

    const body: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (current.trim() === '' || (body.length > 0 && startsBlock(current)))
        break;
      body.push(current);
      index += 1;
    }
    blocks.push({ type: 'paragraph', children: parseInline(body.join('\n')) });
  }

  return blocks;
};
