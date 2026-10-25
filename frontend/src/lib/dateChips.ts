/**
 * Date chips: a calendar day written into a description or a comment, as
 * Linear has them. The stored form is the ISO day in angle brackets, such as
 * `<2026-10-01>`, the org-mode date stamp. It reads cleanly as plain text in
 * the API, MCP, email and GitHub sync, GitHub shows it literally since a tag
 * name cannot start with a digit, and both the editor and the static renderer
 * read it back as a chip. The chip shows the day in the viewer's locale, as
 * Today, Tomorrow or Yesterday when it is that close, with the full date on
 * hover.
 */

import { parseTypedDate } from './parseDate';
import { weekStartDay } from './preferences';
import { isoDate, longDateLabel, parseIsoDate } from './propertyOptions';

/** A stored date chip anywhere in a run of text. */
export const DATE_TOKEN = /<(\d{4}-\d{2}-\d{2})>/g;

/** A stored date chip at the start of a run of text. */
const LEADING_DATE_TOKEN = /^<(\d{4}-\d{2}-\d{2})>/;

/** The longest text after an `@` the mention menu tries to read as a date. */
const MAX_DATE_QUERY = 24;

/** Whether an ISO day names a real calendar day. */
export const isChipDate = (value: string): boolean => {
  const day = parseIsoDate(value);
  return day !== null && isoDate(day) === value;
};

/** The stored form of a date chip. */
export const dateToken = (value: string): string => `<${value}>`;

/** The stored chip at the start of a source, with its length, or null. */
export const leadingDateToken = (
  source: string
): { value: string; length: number } | null => {
  const match = LEADING_DATE_TOKEN.exec(source);
  const value = match?.[1];
  if (match === null || value === undefined || !isChipDate(value)) return null;
  return { value, length: match[0].length };
};

/** The day a number of days after another, on the local calendar. */
const addDays = (day: Date, count: number): Date =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate() + count);

/** The words a day close to today reads as. */
const RELATIVE: Record<number, string> = {
  [-1]: 'Yesterday',
  0: 'Today',
  1: 'Tomorrow',
};

/**
 * How a chip reads: Today, Tomorrow or Yesterday when it is that close, else
 * the short month and day in the viewer's locale, with the year when it is
 * not this year.
 */
export const dateChipLabel = (value: string, today = new Date()): string => {
  const day = parseIsoDate(value);
  if (day === null) return value;
  for (const [offset, label] of Object.entries(RELATIVE)) {
    if (isoDate(addDays(today, Number(offset))) === value) return label;
  }
  const sameYear = day.getFullYear() === today.getFullYear();
  return day.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
};

/** The full date a chip's tooltip shows, in the viewer's locale. */
export const dateChipTitle = (value: string): string => {
  const day = parseIsoDate(value);
  if (day === null) return value;
  return day.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
};

/** One row of the mention menu's Date group. */
export interface DateMentionOption {
  value: string;
  label: string;
}

/**
 * The text after an `@` the caret is in, when it reads as a date, such as
 * `@Oct 1` or `@next friday`. The `@` must start the text or follow
 * whitespace, and text ending in a space never reads as a date, so a space
 * then Enter after `@tom` is a new line rather than a pick.
 */
export const dateMentionQuery = (
  before: string
): { start: number; query: string } | null => {
  const match = /(^|\s)@([^\s@][^@\n]*)$/.exec(before);
  const query = match?.[2];
  if (query === undefined || query.length > MAX_DATE_QUERY) return null;
  if (/\s$/.test(query)) return null;
  return { start: before.length - query.length - 1, query };
};

/**
 * The Date group the mention menu shows for a query, read by the same fixed
 * grammar as every date picker, never a guess, or an empty list when the
 * query is not a date.
 */
export const dateMentionOptions = (
  query: string,
  today = new Date(),
  weekStart: number = weekStartDay()
): DateMentionOption[] => {
  const day = parseTypedDate(query, today, { weekStart });
  if (day === null) return [];
  const value = isoDate(day);
  return [{ value, label: longDateLabel(value, today) }];
};

/** The days a month grid shows, padded to whole weeks from the week start. */
export const monthGrid = (month: Date, weekStart: number): Date[] => {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const lead = (first.getDay() - weekStart + 7) % 7;
  const daysInMonth = new Date(
    month.getFullYear(),
    month.getMonth() + 1,
    0
  ).getDate();
  const cells = Math.ceil((lead + daysInMonth) / 7) * 7;
  return Array.from(
    { length: cells },
    (_, index) =>
      new Date(month.getFullYear(), month.getMonth(), index - lead + 1)
  );
};

/** The narrow weekday names a month grid heads its columns with. */
export const weekdayNames = (
  weekStart: number
): { day: number; name: string }[] =>
  Array.from({ length: 7 }, (_, index) => {
    const day = (weekStart + index) % 7;
    return {
      day,
      name: new Date(2024, 0, 7 + day).toLocaleDateString(undefined, {
        weekday: 'narrow',
      }),
    };
  });
