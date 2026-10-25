/**
 * A small Markdown parser for issue descriptions and comments. It covers what
 * people write in a tracker (paragraphs, headings, lists and task lists,
 * quotes, fenced code, inline code, emphasis, links, embedded images and
 * videos, @mentions, issue keys, date chips, `<details>` collapsible sections and
 * GitHub alert callouts such as `> [!NOTE]`, and LaTeX math as `$...$` inline
 * or a `$$` block) and nothing that would need raw HTML: the output is a tree the renderer turns
 * into React elements, so no string from a comment is ever parsed as markup.
 *
 * Link targets are limited to http, https, mailto and an attachment's content
 * path, so a `javascript:` URL in a comment renders as text rather than as a
 * link. An embed loads only from https or a content path. A YouTube, Loom,
 * Vimeo or Descript link alone in its paragraph is a video embed, as the
 * editor reads it.
 */

import { calloutFromQuote, type CalloutKind } from './callouts';
import { isChipDate } from './dateChips';
import { INLINE_MATH_SOURCE, MATH_FENCE, MATH_ONE_LINE } from './math';
import { isContentPath, isEmbeddableSrc, isVideoSrc } from './media';
import { videoEmbedOfLine, type VideoEmbed } from './videoEmbeds';

/** One inline run. */
export type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'link'; href: string; children: InlineNode[] }
  | { type: 'strong' | 'em' | 'del'; children: InlineNode[] }
  | { type: 'mention'; handle: string }
  | { type: 'issue'; key: string }
  | { type: 'date'; value: string }
  | { type: 'math'; latex: string }
  | { type: 'image' | 'video'; src: string; alt: string }
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
  | { type: 'details'; summary: string; children: BlockNode[] }
  | { type: 'callout'; kind: CalloutKind; children: BlockNode[] }
  | { type: 'embed'; embed: VideoEmbed }
  | { type: 'math'; latex: string }
  | { type: 'rule' };

/** The schemes a link may point at. */
const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** Whether a link target is one the renderer may make clickable. */
export const isSafeUrl = (href: string): boolean => SAFE_URL.test(href.trim());

/** Whether a link target is clickable here, including an attachment's content path. */
export const isLinkTarget = (href: string): boolean =>
  isSafeUrl(href) || isContentPath(href);

/**
 * The inline grammar, tried left to right at each position. The groups are,
 * in order: an embed, a code span, an inline equation, a link, a bare URL, strong, strong with underscores,
 * strikethrough, emphasis, emphasis with underscores, a mention, an issue
 * key such as `ENG-12`, a backslash escape, which the rich editor writes when literal text would
 * otherwise read as formatting, and a date chip such as `<2026-10-01>`.
 */
const INLINE_BASE =
  /!\[([^\]]*)\]\(([^)\s]+)\)|(`+)([^`]|[^`][\s\S]*?[^`])\3(?!`)|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<]*[^\s<.,:;"')\]!?])|\*\*(\S[\s\S]*?)\*\*|__(\S[\s\S]*?)__|~~(\S[\s\S]*?)~~|\*(\S[\s\S]*?)\*|(?<![\w])_(\S[\s\S]*?)_(?![\w])|(?<![\w@/])@([A-Za-z0-9][A-Za-z0-9_-]{0,38})(?![\w-])|(?<![\w/-])([A-Z][A-Z0-9]{1,5}-\d{1,9})(?![\w-])|\\([!-/:-@[-`{-~])|<(\d{4}-\d{2}-\d{2})>/;

/** The inline grammar with the inline equation placed after the code span. */
const INLINE = new RegExp(
  INLINE_BASE.source.replace('(?!`)|', `(?!\`)|${INLINE_MATH_SOURCE}|`),
  'g'
);

/** Appends text, merging it into a text node already at the end. */
const pushText = (out: InlineNode[], value: string): void => {
  if (value === '') return;
  const last = out[out.length - 1];
  if (last?.type === 'text') last.value += value;
  else out.push({ type: 'text', value });
};

/** The non-breaking space entity, which Markdown readers show as a space. */
const NBSP_ENTITY = /&nbsp;/g;

/**
 * Splits text on newlines into text and hard breaks, reading `&nbsp;` as the
 * space it stands for rather than as its letters.
 */
const pushLines = (out: InlineNode[], value: string): void => {
  value.split('\n').forEach((line, index) => {
    if (index > 0) out.push({ type: 'break' });
    pushText(out, line.replace(NBSP_ENTITY, '\u00a0'));
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
      embedAlt,
      embedSrc,
      ,
      code,
      math,
      linkText,
      linkHref,
      bare,
      strong,
      strongAlt,
      del,
      em,
      emAlt,
      mention,
      issueRef,
      escaped,
      dateValue,
    ] = match;
    if (embedAlt !== undefined && embedSrc !== undefined) {
      if (isEmbeddableSrc(embedSrc)) {
        out.push({
          type: isVideoSrc(embedSrc) ? 'video' : 'image',
          src: embedSrc,
          alt: embedAlt,
        });
      } else {
        pushText(out, whole);
      }
    } else if (code !== undefined) {
      out.push({ type: 'code', value: code });
    } else if (math !== undefined) {
      out.push({ type: 'math', latex: math });
    } else if (linkText !== undefined && linkHref !== undefined) {
      if (isLinkTarget(linkHref)) {
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
    } else if (issueRef !== undefined) {
      out.push({ type: 'issue', key: issueRef });
    } else if (escaped !== undefined) {
      pushText(out, escaped);
    } else if (dateValue !== undefined && isChipDate(dateValue)) {
      out.push({ type: 'date', value: dateValue });
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
const DETAILS_OPEN = /^\s{0,3}<details(?:\s[^>]*)?>\s*(.*)$/i;
const DETAILS_CLOSE = /^\s{0,3}<\/details>\s*$/i;
const SUMMARY = /^\s*<summary(?:\s[^>]*)?>(.*?)<\/summary>\s*$/i;

/**
 * Whether a line is blank. A line of only `&nbsp;` counts, since older
 * versions of the rich editor stored one for each extra blank line.
 */
const isBlank = (line: string): boolean =>
  line.replace(NBSP_ENTITY, '').trim() === '';

/** The entities a collapsible section's summary is written with. */
const SUMMARY_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  '#x27': "'",
  nbsp: '\u00a0',
};

/** An entity the summary reader decodes, so a bare `&` before one is escaped. */
const SUMMARY_ENTITY = /&(amp|lt|gt|quot|#39|#x27|nbsp);/gi;

/**
 * A summary as the text it reads as: tags such as GitHub's `<b>` dropped and
 * the entities the writer uses decoded.
 */
export const readSummary = (raw: string): string =>
  raw
    .replace(/<[^>]*>/g, '')
    .replace(
      SUMMARY_ENTITY,
      (whole, name: string) => SUMMARY_ENTITIES[name.toLowerCase()] ?? whole
    )
    .trim();

/**
 * A summary's text as it is written between `<summary>` tags, with only what
 * would read as markup or as an entity escaped, so GitHub shows the same text.
 */
export const writeSummary = (text: string): string =>
  text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/&(?=(amp|lt|gt|quot|#39|#x27|nbsp);)/gi, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** A collapsible section found at a line, and the line after it. */
export interface CollapsibleMatch {
  summary: string;
  body: string;
  end: number;
}

/**
 * The `<details>` section that starts at a line, or null. The summary sits on
 * the opening line or the first line after it, nested sections and fenced
 * code are skipped while looking for the matching `</details>`, and a section
 * that never closes is not one, so its tags stay text.
 */
export const collapsibleAt = (
  lines: string[],
  start: number
): CollapsibleMatch | null => {
  const opening = DETAILS_OPEN.exec(lines[start] ?? '');
  if (opening === null) return null;
  let index = start + 1;
  let summary = '';
  const rest = (opening[1] ?? '').trim();
  if (rest !== '') {
    const inline = SUMMARY.exec(rest);
    if (inline === null) return null;
    summary = readSummary(inline[1] ?? '');
  } else {
    let next = index;
    while (next < lines.length && isBlank(lines[next] ?? '')) next += 1;
    const own = SUMMARY.exec(lines[next] ?? '');
    if (own !== null) {
      summary = readSummary(own[1] ?? '');
      index = next + 1;
    }
  }
  const body: string[] = [];
  let depth = 1;
  let fence: string | null = null;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (fence !== null) {
      if (line.trim().startsWith(fence)) fence = null;
    } else {
      const opened = FENCE.exec(line);
      if (opened !== null) fence = opened[1] ?? '```';
      else if (DETAILS_OPEN.test(line)) depth += 1;
      else if (DETAILS_CLOSE.test(line)) {
        depth -= 1;
        if (depth === 0) {
          return {
            summary,
            body: body
              .join('\n')
              .replace(/^\s*\n/, '')
              .trimEnd(),
            end: index + 1,
          };
        }
      }
    }
    body.push(line);
    index += 1;
  }
  return null;
};

/**
 * The `$$` block equation that opens at a line, with the line after its
 * closing `$$`, or null. A fence that never closes is not one, so it stays
 * text.
 */
const mathBlockAt = (
  lines: string[],
  start: number
): { latex: string; end: number } | null => {
  if (!MATH_FENCE.test(lines[start] ?? '')) return null;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (MATH_FENCE.test(lines[index] ?? '')) {
      return {
        latex: lines
          .slice(start + 1, index)
          .join('\n')
          .replace(/^\n+|\s+$/g, ''),
        end: index + 1,
      };
    }
  }
  return null;
};

/** Whether a line starts a block other than a paragraph. */
const startsBlock = (line: string): boolean =>
  FENCE.test(line) ||
  MATH_FENCE.test(line) ||
  MATH_ONE_LINE.test(line) ||
  DETAILS_OPEN.test(line) ||
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

    if (isBlank(line)) {
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

    const oneLine = MATH_ONE_LINE.exec(line);
    if (oneLine !== null) {
      blocks.push({ type: 'math', latex: (oneLine[1] ?? '').trim() });
      index += 1;
      continue;
    }

    const equation = mathBlockAt(lines, index);
    if (equation !== null) {
      blocks.push({ type: 'math', latex: equation.latex });
      index = equation.end;
      continue;
    }

    const section = collapsibleAt(lines, index);
    if (section !== null) {
      blocks.push({
        type: 'details',
        summary: section.summary,
        children: parseMarkdown(section.body),
      });
      index = section.end;
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
      const callout = calloutFromQuote(body);
      blocks.push(
        callout === null
          ? { type: 'quote', children: parseMarkdown(body.join('\n')) }
          : {
              type: 'callout',
              kind: callout.kind,
              children: parseMarkdown(callout.body),
            }
      );
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
          !isBlank(current) &&
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
      if (isBlank(current) || (body.length > 0 && startsBlock(current))) break;
      body.push(current);
      index += 1;
    }
    const embed =
      body.length === 1 && isBlank(lines[index] ?? '')
        ? videoEmbedOfLine(body[0] ?? '')
        : null;
    blocks.push(
      embed === null
        ? { type: 'paragraph', children: parseInline(body.join('\n')) }
        : { type: 'embed', embed }
    );
  }

  return blocks;
};
