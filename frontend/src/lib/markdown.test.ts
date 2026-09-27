import { describe, expect, it } from 'vitest';
import { isSafeUrl, parseInline, parseMarkdown } from './markdown';

describe('parseInline', () => {
  it('reads emphasis, code and strikethrough', () => {
    expect(parseInline('a **bold** and *soft* `x` ~~gone~~')).toEqual([
      { type: 'text', value: 'a ' },
      { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
      { type: 'text', value: ' and ' },
      { type: 'em', children: [{ type: 'text', value: 'soft' }] },
      { type: 'text', value: ' ' },
      { type: 'code', value: 'x' },
      { type: 'text', value: ' ' },
      { type: 'del', children: [{ type: 'text', value: 'gone' }] },
    ]);
  });

  it('keeps Markdown inside a code span as text', () => {
    expect(parseInline('`**not bold**`')).toEqual([
      { type: 'code', value: '**not bold**' },
    ]);
  });

  it('links http, https and mailto targets', () => {
    expect(parseInline('[docs](https://example.com/a)')).toEqual([
      {
        type: 'link',
        href: 'https://example.com/a',
        children: [{ type: 'text', value: 'docs' }],
      },
    ]);
  });

  it('embeds an image by its stored content path', () => {
    const src = '/api/workspaces/ws-1/attachments/att-1/content?issue_id=iss-1';
    expect(parseInline(`![shot.png](${src})`)).toEqual([
      { type: 'image', src, alt: 'shot.png' },
    ]);
  });

  it('embeds a video when the content path carries the marker', () => {
    const src =
      '/api/workspaces/ws-1/attachments/att-2/content?issue_id=iss-1&media=video';
    expect(parseInline(`![demo.mp4](${src})`)).toEqual([
      { type: 'video', src, alt: 'demo.mp4' },
    ]);
  });

  it('embeds an https image and leaves any other target as text', () => {
    expect(parseInline('![a](https://example.com/a.png)')).toEqual([
      { type: 'image', src: 'https://example.com/a.png', alt: 'a' },
    ]);
    expect(parseInline('![a](javascript:alert)')).toEqual([
      { type: 'text', value: '![a](javascript:alert)' },
    ]);
    expect(parseInline('![a](http://example.com/a.png)')).toEqual([
      { type: 'text', value: '![a](http://example.com/a.png)' },
    ]);
  });

  it('links a file by its stored content path', () => {
    const href =
      '/api/workspaces/ws-1/attachments/att-3/content?issue_id=iss-1';
    expect(parseInline(`[trace.pdf](${href})`)).toEqual([
      { type: 'link', href, children: [{ type: 'text', value: 'trace.pdf' }] },
    ]);
  });

  it('refuses a javascript target and leaves the text as written', () => {
    expect(parseInline('[x](javascript:alert(1))')).toEqual([
      { type: 'text', value: '[x](javascript:alert(1))' },
    ]);
  });

  it('turns a bare URL into a link without its trailing punctuation', () => {
    expect(parseInline('see https://example.com/x.')).toEqual([
      { type: 'text', value: 'see ' },
      {
        type: 'link',
        href: 'https://example.com/x',
        children: [{ type: 'text', value: 'https://example.com/x' }],
      },
      { type: 'text', value: '.' },
    ]);
  });

  it('reads a mention but not an email address', () => {
    expect(parseInline('ping @tyler, mail a@b.com')).toEqual([
      { type: 'text', value: 'ping ' },
      { type: 'mention', handle: 'tyler' },
      { type: 'text', value: ', mail a@b.com' },
    ]);
  });

  it('keeps a single newline as a break', () => {
    expect(parseInline('one\ntwo')).toEqual([
      { type: 'text', value: 'one' },
      { type: 'break' },
      { type: 'text', value: 'two' },
    ]);
  });

  it('reads a backslash escape as the literal character', () => {
    expect(parseInline('literal \\*not em\\* and a\\_b')).toEqual([
      { type: 'text', value: 'literal *not em* and a_b' },
    ]);
  });
});

describe('parseMarkdown', () => {
  it('splits paragraphs on blank lines', () => {
    expect(parseMarkdown('one\n\ntwo').map((block) => block.type)).toEqual([
      'paragraph',
      'paragraph',
    ]);
  });

  it('reads headings, rules, quotes and fenced code', () => {
    const blocks = parseMarkdown(
      '# Title\n---\n> quoted\n```ts\nconst a = 1;\n```'
    );
    expect(blocks).toEqual([
      {
        type: 'heading',
        level: 1,
        children: [{ type: 'text', value: 'Title' }],
      },
      { type: 'rule' },
      {
        type: 'quote',
        children: [
          { type: 'paragraph', children: [{ type: 'text', value: 'quoted' }] },
        ],
      },
      { type: 'code', language: 'ts', value: 'const a = 1;' },
    ]);
  });

  it('reads bullet, ordered and task lists', () => {
    const [bullets, ordered, tasks] = parseMarkdown(
      '- a\n- b\n\n3. c\n4. d\n\n- [x] done\n- [ ] open'
    );
    expect(bullets).toMatchObject({ type: 'list', ordered: false });
    expect(ordered).toMatchObject({ type: 'list', ordered: true, start: 3 });
    expect(tasks).toMatchObject({
      type: 'list',
      items: [{ checked: true }, { checked: false }],
    });
  });

  it('reads a line of only &nbsp; as a blank line', () => {
    expect(parseMarkdown('one\n\n&nbsp;\n\n &nbsp;&nbsp; \n\ntwo')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', value: 'one' }] },
      { type: 'paragraph', children: [{ type: 'text', value: 'two' }] },
    ]);
  });

  it('reads &nbsp; inside text as a non-breaking space', () => {
    expect(parseMarkdown('a&nbsp;b')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', value: 'a\u00a0b' }] },
    ]);
  });

  it('keeps &nbsp; in code as written', () => {
    expect(parseMarkdown('```\n&nbsp;\n```\n\n`&nbsp;`')).toEqual([
      { type: 'code', language: '', value: '&nbsp;' },
      { type: 'paragraph', children: [{ type: 'code', value: '&nbsp;' }] },
    ]);
  });

  it('leaves an unclosed fence running to the end', () => {
    expect(parseMarkdown('```\nopen')).toEqual([
      { type: 'code', language: '', value: 'open' },
    ]);
  });
});

describe('isSafeUrl', () => {
  it('accepts web and mail links only', () => {
    expect(isSafeUrl('https://a.b')).toBe(true);
    expect(isSafeUrl('mailto:a@b.c')).toBe(true);
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('data:text/html,x')).toBe(false);
  });
});
