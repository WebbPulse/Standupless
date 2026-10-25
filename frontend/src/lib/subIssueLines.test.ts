/**
 * Splitting text into sub-issue titles: list markers and inline Markdown
 * dropped, blank lines skipped, a passage that is not all list items refused
 * as a list, and the prefill and comment description a passage gives.
 */

import { describe, expect, it } from 'vitest';
import {
  commentSubIssueBody,
  isListLine,
  listTitles,
  plainInline,
  splitTitles,
  stripListMarker,
  textPrefill,
  titleOfLine,
} from './subIssueLines';
import { TITLE_MAX } from './validation';

describe('list markers', () => {
  it('reads bullets, numbers and checkboxes as markers', () => {
    expect(isListLine('- one')).toBe(true);
    expect(isListLine('* one')).toBe(true);
    expect(isListLine('+ one')).toBe(true);
    expect(isListLine('• one')).toBe(true);
    expect(isListLine('1. one')).toBe(true);
    expect(isListLine('12) one')).toBe(true);
    expect(isListLine('- [ ] one')).toBe(true);
    expect(isListLine('[x] one')).toBe(true);
    expect(isListLine('    - nested')).toBe(true);
  });

  it('refuses plain lines and markers with nothing after them', () => {
    expect(isListLine('one')).toBe(false);
    expect(isListLine('-one')).toBe(false);
    expect(isListLine('- ')).toBe(false);
    expect(isListLine('2026 was a year')).toBe(false);
  });

  it('strips the marker and leaves the text', () => {
    expect(stripListMarker('- [x] Ship it')).toBe('Ship it');
    expect(stripListMarker('3. Third')).toBe('Third');
    expect(stripListMarker('No marker')).toBe('No marker');
  });
});

describe('plainInline', () => {
  it('reads links, emphasis and code as their text', () => {
    expect(plainInline('Read [the docs](https://x.test) now')).toBe(
      'Read the docs now'
    );
    expect(plainInline('**bold** and _italic_ and ~~gone~~')).toBe(
      'bold and italic and gone'
    );
    expect(plainInline('Run `make build`')).toBe('Run make build');
    expect(plainInline('![logo](a.png) here')).toBe('logo here');
  });

  it('keeps underscores inside words', () => {
    expect(plainInline('rename snake_case_name')).toBe(
      'rename snake_case_name'
    );
  });
});

describe('splitTitles', () => {
  it('gives one title per non-blank line, in order', () => {
    expect(
      splitTitles('- [ ] Write **docs**\r\n\n2. Ship `it`\n* [x] Done\n')
    ).toEqual(['Write docs', 'Ship it', 'Done']);
  });

  it('keeps plain lines and collapses their spaces', () => {
    expect(splitTitles('First   one\nSecond\t\tone')).toEqual([
      'First one',
      'Second one',
    ]);
  });

  it('drops lines that hold nothing once read as text', () => {
    expect(splitTitles('- \n   \nReal')).toEqual(['Real']);
  });

  it('caps each title at the limit', () => {
    const [title] = splitTitles('x'.repeat(TITLE_MAX + 20));
    expect(title).toHaveLength(TITLE_MAX);
  });
});

describe('listTitles', () => {
  it('reads a passage of list items, nested ones included', () => {
    expect(listTitles('- one\n  - two\n- three')).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  it('refuses a passage with a line that is not a list item', () => {
    expect(listTitles('Intro\n- one\n- two')).toBeNull();
    expect(listTitles('')).toBeNull();
  });
});

describe('textPrefill', () => {
  it('takes the first line with text as the title and the rest as the description', () => {
    expect(textPrefill('\n- First line\nmore\n\nlines\n')).toEqual({
      title: 'First line',
      description: 'more\n\nlines',
    });
  });

  it('gives nothing for an empty passage', () => {
    expect(textPrefill('  \n ')).toEqual({ title: '', description: '' });
  });
});

describe('commentSubIssueBody', () => {
  it('follows the comment with a link back to it', () => {
    expect(commentSubIssueBody('  Fix it  ', '/w/issue/ENG-1#c-1')).toBe(
      'Fix it\n\n[From a comment](/w/issue/ENG-1#c-1)'
    );
  });

  it('is only the link for an empty comment', () => {
    expect(commentSubIssueBody('', '/c')).toBe('[From a comment](/c)');
  });
});

describe('titleOfLine', () => {
  it('collapses spaces and trims', () => {
    expect(titleOfLine('  a   b  ')).toBe('a b');
  });
});
