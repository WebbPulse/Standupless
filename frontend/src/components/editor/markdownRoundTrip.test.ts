/**
 * Holds the rich editor to the stored Markdown. A description goes into the
 * editor and comes back out on every save, and the share view, emails and the
 * GitHub sync read the stored text, so anything the editor rewrites changes
 * what everyone else sees. Most documents come back byte for byte; the few
 * spellings the editor normalizes are listed here, and each one is stable on
 * a second pass so a description never drifts save after save. Collapsible
 * sections store as GitHub's `<details>` block and read back as the same
 * section in the static renderer.
 */

import { Editor } from '@tiptap/core';
import { afterAll, describe, expect, it } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { parseMarkdown } from '../../lib/markdown';
import { markdownExtensions } from './markdownExtensions';
import { readMarkdown, writeMarkdown } from './markdownCodec';

const editor = new Editor({ extensions: markdownExtensions() });

afterAll(() => {
  editor.destroy();
});

/** The Markdown the editor writes back after reading the source. */
const roundTrip = (source: string): string => {
  writeMarkdown(editor, source);
  return readMarkdown(editor);
};

const EXACT: [string, string][] = [
  [
    'headings and marks',
    '# Heading\n\nSome **bold** and *em* and `code` and ~~del~~.',
  ],
  ['a smaller heading', '## Sub\n\ntext'],
  ['a task list', '- [ ] todo\n- [x] done'],
  ['nested bullets', '- one\n  - nested\n    - deeper\n- two'],
  ['nested ordered items', '1. first\n2. second\n   1. inner'],
  [
    'a code fence with a blank line',
    '```ts\nconst a = 1;\n\nconst b = 2;\n```',
  ],
  ['a fenced ts block keeps its alias', '```ts\nconst a: number = 1;\n```'],
  ['a fenced python block', '```python\nprint("hi")\n```'],
  ['a fence in a language the picker does not list', '```foo\nx\n```'],
  ['a fence with no language', '```\nplain text\n```'],
  ['an image', '![alt text](https://example.com/a.png)'],
  [
    'an uploaded image',
    '![shot.png](/api/workspaces/ws-1/attachments/att-1/content?issue_id=iss-1)',
  ],
  [
    'an uploaded video',
    '![demo.mp4](/api/workspaces/ws-1/attachments/att-2/content?issue_id=iss-1&media=video)',
  ],
  [
    'an uploaded file link',
    '[trace.pdf](/api/workspaces/ws-1/attachments/att-3/content?issue_id=iss-1)',
  ],
  ['a quote', '> quoted\n> more'],
  ['literal angle brackets', 'Use a <div> element and a <b>tag</b>.'],
  ['a single line break', 'line one\nline two'],
  [
    'links, bare URLs and mentions',
    'See [docs](https://example.com) and https://bare.example.com and @alice-b.',
  ],
  ['a rule', 'a\n\n---\n\nb'],
  ['an unsafe link left as text', '[x](javascript:alert(1))'],
  [
    'underscores and stars in prose',
    'snake_case_name and 2 * 3 * 4 and a_b and a < b & c',
  ],
  ['backslash escapes', 'literal \\*not em\\*'],
  [
    'a collapsible section',
    '<details>\n<summary>Logs</summary>\n\nbody\n\n</details>',
  ],
  [
    'a collapsible section between paragraphs',
    'before\n\n<details>\n<summary>Logs</summary>\n\nbody\n\n</details>\n\nafter',
  ],
  [
    'a collapsible section holding a list and a fence',
    '<details>\n<summary>Steps</summary>\n\n- one\n- two\n\n```\n</details>\n```\n\n</details>',
  ],
  [
    'nested collapsible sections',
    '<details>\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\ntext\n\n</details>\n\n</details>',
  ],
  [
    'an empty collapsible section',
    '<details>\n<summary>Empty</summary>\n\n</details>',
  ],
  [
    'a collapsible summary with escaped markup',
    '<details>\n<summary>a &lt;b&gt; &amp;lt; c & d</summary>\n\nx\n\n</details>',
  ],
];

const NORMALIZED: [string, string, string][] = [
  [
    'tables pad their columns',
    '| a | b |\n| --- | --- |\n| 1 | 2 |',
    '| a   | b   |\n| --- | --- |\n| 1   | 2   |',
  ],
  [
    'star bullets become dashes',
    '* star bullet\n* two',
    '- star bullet\n- two',
  ],
  [
    'underscore emphasis becomes stars',
    '__bold__ and _em_',
    '**bold** and *em*',
  ],
  [
    'an open collapsible section drops its open flag',
    '<details open>\n<summary>Logs</summary>\nbody\n</details>',
    '<details>\n<summary>Logs</summary>\n\nbody\n\n</details>',
  ],
  [
    'the GitHub one line summary moves onto its own line',
    '<details><summary><b>Logs</b></summary>\n\nbody\n</details>',
    '<details>\n<summary>Logs</summary>\n\nbody\n\n</details>',
  ],
  [
    'a collapsible section without a summary gains an empty one',
    '<details>\n\nbody\n\n</details>',
    '<details>\n<summary></summary>\n\nbody\n\n</details>',
  ],
];

describe('the rich editor Markdown round trip', () => {
  it.each(EXACT)('keeps %s byte for byte', (_name, source) => {
    expect(roundTrip(source)).toBe(source);
  });

  it.each(NORMALIZED)('normalizes: %s', (_name, source, expected) => {
    const once = roundTrip(source);
    expect(once).toBe(expected);
    expect(roundTrip(once)).toBe(once);
  });

  it('reads an empty document as the empty string', () => {
    expect(roundTrip('')).toBe('');
  });

  it('keeps every blank line inside a code fence', () => {
    const source = '```\na\n\n\n\nb\n```';
    expect(roundTrip(source)).toBe(source);
  });
});

/** A paragraph node holding text, or an empty one when there is none. */
const paragraph = (text?: string): JSONContent =>
  text === undefined
    ? { type: 'paragraph' }
    : { type: 'paragraph', content: [{ type: 'text', text }] };

/** The Markdown the editor writes for a document typed as paragraphs. */
const typed = (...paragraphs: (string | undefined)[]): string => {
  editor.commands.setContent({
    type: 'doc',
    content: paragraphs.map(paragraph),
  });
  return readMarkdown(editor);
};

describe('blank lines typed in the rich editor', () => {
  it('collapse into one paragraph break and never write &nbsp;', () => {
    const markdown = typed(
      'first',
      'second',
      undefined,
      undefined,
      undefined,
      'third',
      undefined,
      undefined
    );
    expect(markdown).toBe('first\n\nsecond\n\nthird');
  });

  it('reach the static renderer as paragraphs with no entity text', () => {
    const markdown = typed('one', undefined, undefined, undefined, 'two');
    expect(parseMarkdown(markdown)).toEqual([
      { type: 'paragraph', children: [{ type: 'text', value: 'one' }] },
      { type: 'paragraph', children: [{ type: 'text', value: 'two' }] },
    ]);
  });

  it('leave an all blank document empty', () => {
    expect(typed(undefined, undefined, undefined)).toBe('');
  });

  it('drop the &nbsp; lines a stored body already carries on its next save', () => {
    const stored = 'one\n\n\n\n&nbsp;\n\n&nbsp;\n\ntwo';
    const saved = roundTrip(stored);
    expect(saved).toBe('one\n\ntwo');
    expect(roundTrip(saved)).toBe(saved);
  });
});

describe('collapsible sections in the rich editor', () => {
  it('read as one section node that starts closed', () => {
    writeMarkdown(
      editor,
      '<details>\n<summary>Logs</summary>\n\nbody\n\n</details>'
    );
    const [section] = editor.getJSON().content ?? [];
    expect(section?.type).toBe('collapsibleSection');
    expect(section?.attrs?.['open']).toBe(false);
    expect(section?.content?.map((child) => child.type)).toEqual([
      'collapsibleSummary',
      'collapsibleBody',
    ]);
  });

  it('leave a details tag that never closes as text', () => {
    writeMarkdown(editor, '<details>\n<summary>x</summary>\n\nbody');
    const types = (editor.getJSON().content ?? []).map((child) => child.type);
    expect(types).not.toContain('collapsibleSection');
    expect(readMarkdown(editor)).toContain('<details>');
  });

  it('write what the static renderer reads as the same section', () => {
    const source =
      '<details>\n<summary>Logs</summary>\n\n- one\n- two\n\n</details>';
    expect(parseMarkdown(roundTrip(source))).toEqual([
      {
        type: 'details',
        summary: 'Logs',
        children: [
          {
            type: 'list',
            ordered: false,
            start: 1,
            items: [
              {
                checked: null,
                children: [{ type: 'text', value: 'one' }],
              },
              {
                checked: null,
                children: [{ type: 'text', value: 'two' }],
              },
            ],
          },
        ],
      },
    ]);
  });
});
