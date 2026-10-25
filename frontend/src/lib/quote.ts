/**
 * Quoting a comment or a selected passage into a reply, as Linear does: the
 * passage becomes a Markdown blockquote, so mentions, issue keys and links in
 * it stay the text that draws them as chips and links. Quoting a selection
 * reads the rendered passage back into that Markdown, using the source a chip
 * carries on its `data-md` attribute, so a chip quotes as what was written
 * rather than as the label it shows. Everything here is a plain text
 * transform.
 */

/** Elements whose content belongs in a block of its own. */
const BLOCKS = new Set([
  'P',
  'DIV',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'UL',
  'OL',
  'TABLE',
  'TR',
  'DETAILS',
  'SUMMARY',
  'SECTION',
  'ARTICLE',
]);

/** Inline marks and the Markdown that wraps their text. */
const MARKS: Record<string, string> = {
  STRONG: '**',
  B: '**',
  EM: '_',
  I: '_',
  DEL: '~~',
  S: '~~',
};

/** Elements that draw controls or decoration, never quoted text. */
const SKIPPED = new Set(['BUTTON', 'SVG', 'INPUT', 'SCRIPT', 'STYLE']);

/**
 * A Markdown passage as a blockquote: every line marked, a blank line kept as
 * a bare marker so the quote stays one block. Empty text quotes as nothing.
 */
export const quoteMarkdown = (markdown: string): string => {
  const text = markdown.replace(/\r\n?/g, '\n').trim();
  if (text === '') return '';
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');
};

/** Wraps marked text, keeping the spaces around it outside the marks. */
const wrap = (inner: string, mark: string): string => {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  if (match === null || match[2] === '') return inner;
  return `${match[1] ?? ''}${mark}${match[2] ?? ''}${mark}${match[3] ?? ''}`;
};

/** One node of a rendered passage as Markdown, its children in order. */
const nodeMarkdown = (node: Node): string => {
  const childrenMarkdown = (parent: Node): string =>
    Array.from(parent.childNodes).map(nodeMarkdown).join('');
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return childrenMarkdown(node);
  }
  const element = node as Element;
  const tag = element.tagName.toUpperCase();
  if (SKIPPED.has(tag) || element.getAttribute('aria-hidden') === 'true') {
    return '';
  }
  const source = element.getAttribute('data-md');
  if (source !== null) return source;
  if (tag === 'BR') return '\n';
  if (tag === 'IMG') {
    const src = element.getAttribute('src') ?? '';
    return src === '' ? '' : `![${element.getAttribute('alt') ?? ''}](${src})`;
  }
  if (tag === 'PRE') {
    const code = (element.textContent ?? '').replace(/\n$/, '');
    return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`;
  }
  const inner = childrenMarkdown(element);
  if (tag === 'CODE') return inner === '' ? '' : `\`${inner}\``;
  const mark = MARKS[tag];
  if (mark !== undefined) return wrap(inner, mark);
  if (tag === 'A') {
    const href =
      element.getAttribute('data-md-href') ?? element.getAttribute('href');
    const text = inner.trim();
    if (href === null || href === '' || text === '') return inner;
    return text === href ? href : `[${text}](${href})`;
  }
  if (tag === 'LI') return `\n- ${inner.trim()}`;
  if (BLOCKS.has(tag)) return `\n\n${inner}\n\n`;
  return inner;
};

/**
 * A rendered passage, such as the contents of a selection, read back into the
 * Markdown that draws it. Blocks are separated by one blank line and the
 * passage is trimmed.
 */
export const fragmentMarkdown = (fragment: Node): string =>
  Array.from(fragment.childNodes)
    .map(nodeMarkdown)
    .join('')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * The selected passage as Markdown, or empty when the range selects nothing
 * but space.
 */
export const rangeMarkdown = (range: Range): string =>
  fragmentMarkdown(range.cloneContents());
