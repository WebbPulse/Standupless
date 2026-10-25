/**
 * Splitting text into sub-issue titles, as Linear does when a list is turned
 * into sub-issues or several lines are pasted into the sub-issue row. A line's
 * bullet, number or checkbox is dropped, inline Markdown is read as the text it
 * draws, and blank lines are skipped. Everything here is a plain text
 * transform.
 */

import { TITLE_MAX } from './validation';

/** The marker a list line opens with: a bullet, a number, a checkbox or both. */
const LIST_MARKER =
  /^\s*(?:(?:[-*+•]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|\[[ xX]\]\s+)/;

/** A title as the dialog accepts it: spaces collapsed and at most the limit. */
export const titleOfLine = (line: string): string =>
  line.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX).trimEnd();

/** Whether a line is a list item with text after its marker. */
export const isListLine = (line: string): boolean => {
  const marker = LIST_MARKER.exec(line);
  return marker !== null && line.slice(marker[0].length).trim() !== '';
};

/** A line without the bullet, number or checkbox it opens with. */
export const stripListMarker = (line: string): string =>
  line.replace(LIST_MARKER, '');

/** Inline Markdown read as the text it draws: links, emphasis and code. */
export const plainInline = (markdown: string): string =>
  markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_](\S(?:.*?\S)?)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1');

/** The non-blank lines of a passage, its line endings normalised. */
const linesOf = (text: string): string[] =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.trim() !== '');

/**
 * The titles pasted text holds, one per non-blank line, each without its list
 * marker. Lines that hold nothing once read as text are dropped.
 */
export const splitTitles = (text: string): string[] =>
  linesOf(text)
    .map((line) => titleOfLine(plainInline(stripListMarker(line))))
    .filter((title) => title !== '');

/**
 * The titles of a Markdown passage made only of list items, one per item and
 * nested items included, or null when any line is not a list item.
 */
export const listTitles = (markdown: string): string[] | null => {
  const lines = linesOf(markdown);
  if (lines.length === 0 || !lines.every(isListLine)) return null;
  return splitTitles(lines.join('\n'));
};

/** The title and description a passage of text files one issue with. */
export interface TextPrefill {
  title: string;
  description: string;
}

/**
 * The prefill a Markdown passage gives: its first line with text in it as the
 * title, read as plain text without any list marker, and the rest as the
 * description.
 */
export const textPrefill = (markdown: string): TextPrefill => {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  for (let at = 0; at < lines.length; at += 1) {
    const title = titleOfLine(plainInline(stripListMarker(lines[at] ?? '')));
    if (title !== '') {
      return {
        title,
        description: lines
          .slice(at + 1)
          .join('\n')
          .trim(),
      };
    }
  }
  return { title: '', description: '' };
};

/**
 * The description a sub-issue filed from a comment starts with: the comment's
 * Markdown, then a link back to the comment.
 */
export const commentSubIssueBody = (body: string, url: string): string => {
  const link = `[From a comment](${url})`;
  const text = body.trim();
  return text === '' ? link : `${text}\n\n${link}`;
};
