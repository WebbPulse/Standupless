/**
 * Reads a typed date, such as "fri", "in 3 days", "nov 12" or "2026-11-12",
 * as a local calendar day counted from a given today. Deterministic and
 * offline: a small grammar of fixed phrases, never a guess.
 */

/** How a parse reads ambiguous input. */
export interface ParseDateOptions {
  /** The day the viewer's week starts, 0 for Sunday, 1 for Monday. */
  weekStart?: number;
  /** Whether `11/12` reads as the 11th of December rather than November 12. */
  dayFirst?: boolean;
}

const WEEKDAYS: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

const UNITS: Record<string, 'day' | 'week' | 'month' | 'year'> = {
  d: 'day',
  day: 'day',
  days: 'day',
  w: 'week',
  wk: 'week',
  wks: 'week',
  week: 'week',
  weeks: 'week',
  m: 'month',
  mo: 'month',
  mos: 'month',
  month: 'month',
  months: 'month',
  y: 'year',
  yr: 'year',
  yrs: 'year',
  year: 'year',
  years: 'year',
};

/** Whether the viewer's locale writes the day before the month. */
export const localeDayFirst = (locale?: string): boolean => {
  const parts = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'numeric',
  }).formatToParts(new Date(2026, 10, 12));
  const day = parts.findIndex((part) => part.type === 'day');
  const month = parts.findIndex((part) => part.type === 'month');
  return day < month;
};

const startOf = (day: Date): Date =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate());

const addDays = (day: Date, count: number): Date =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate() + count);

const addMonths = (day: Date, count: number): Date => {
  const target = new Date(day.getFullYear(), day.getMonth() + count, 1);
  const last = new Date(
    target.getFullYear(),
    target.getMonth() + 1,
    0
  ).getDate();
  return new Date(
    target.getFullYear(),
    target.getMonth(),
    Math.min(day.getDate(), last)
  );
};

const calendarDay = (
  year: number,
  month: number,
  date: number
): Date | null => {
  if (month < 0 || month > 11 || date < 1) return null;
  const day = new Date(year, month, date);
  return day.getMonth() === month && day.getDate() === date ? day : null;
};

const fullYear = (text: string): number => {
  const year = Number(text);
  return text.length <= 2 ? 2000 + year : year;
};

const monthDay = (
  today: Date,
  month: number,
  date: number,
  yearText: string | undefined
): Date | null => {
  if (yearText !== undefined) {
    return calendarDay(fullYear(yearText), month, date);
  }
  const thisYear = calendarDay(today.getFullYear(), month, date);
  if (thisYear !== null && thisYear >= today) return thisYear;
  return calendarDay(today.getFullYear() + 1, month, date);
};

const amount = (text: string): number =>
  text === 'a' || text === 'an' ? 1 : Number(text);

const shift = (
  today: Date,
  count: number,
  unit: 'day' | 'week' | 'month' | 'year'
): Date => {
  switch (unit) {
    case 'day':
      return addDays(today, count);
    case 'week':
      return addDays(today, count * 7);
    case 'month':
      return addMonths(today, count);
    case 'year':
      return addMonths(today, count * 12);
  }
};

const nextWeekStart = (today: Date, weekStart: number): Date =>
  addDays(today, (weekStart - today.getDay() + 7) % 7 || 7);

const PHRASES: Record<string, (today: Date, weekStart: number) => Date> = {
  today: (today) => today,
  tod: (today) => today,
  now: (today) => today,
  tomorrow: (today) => addDays(today, 1),
  tmr: (today) => addDays(today, 1),
  tmrw: (today) => addDays(today, 1),
  tom: (today) => addDays(today, 1),
  yesterday: (today) => addDays(today, -1),
  'end of week': (today) => addDays(today, (5 - today.getDay() + 7) % 7),
  'end of this week': (today) => addDays(today, (5 - today.getDay() + 7) % 7),
  eow: (today) => addDays(today, (5 - today.getDay() + 7) % 7),
  'end of next week': (today, weekStart) => {
    const start = nextWeekStart(today, weekStart);
    return addDays(start, (5 - start.getDay() + 7) % 7);
  },
  'next week': (today, weekStart) => nextWeekStart(today, weekStart),
  'end of month': (today) =>
    new Date(today.getFullYear(), today.getMonth() + 1, 0),
  'end of this month': (today) =>
    new Date(today.getFullYear(), today.getMonth() + 1, 0),
  eom: (today) => new Date(today.getFullYear(), today.getMonth() + 1, 0),
  'next month': (today) =>
    new Date(today.getFullYear(), today.getMonth() + 1, 1),
  'end of next month': (today) =>
    new Date(today.getFullYear(), today.getMonth() + 2, 0),
  'end of quarter': (today) =>
    new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3 + 3, 0),
  'end of this quarter': (today) =>
    new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3 + 3, 0),
  eoq: (today) =>
    new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3 + 3, 0),
  'next quarter': (today) =>
    new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3 + 3, 1),
  'end of year': (today) => new Date(today.getFullYear(), 11, 31),
  eoy: (today) => new Date(today.getFullYear(), 11, 31),
  'next year': (today) => new Date(today.getFullYear() + 1, 0, 1),
};

/**
 * Reads typed text as a day relative to `today`, or null when the text is not
 * a date. A bare weekday is the next one after today, "next" moves it into
 * the following week, and a month and day already past rolls to next year.
 */
export const parseTypedDate = (
  text: string,
  today: Date,
  options: ParseDateOptions = {}
): Date | null => {
  const weekStart = options.weekStart ?? 1;
  const base = startOf(today);
  const input = text
    .trim()
    .toLowerCase()
    .replace(/[,.]+$/, '')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ');
  if (input === '') return null;

  const phrase = PHRASES[input];
  if (phrase !== undefined) return phrase(base, weekStart);

  const weekday = /^(this |next |on )?([a-z]+)$/.exec(input);
  if (weekday !== null) {
    const target = WEEKDAYS[weekday[2] ?? ''];
    if (target !== undefined) {
      if (weekday[1] === 'next ') {
        const start = nextWeekStart(base, weekStart);
        return addDays(start, (target - weekStart + 7) % 7);
      }
      return addDays(base, (target - base.getDay() + 7) % 7 || 7);
    }
  }

  const relative = /^(in )?(\d+|an?) ?([a-z]+)( from now| later)?$/.exec(input);
  if (relative !== null) {
    const unit = UNITS[relative[3] ?? ''];
    const count = amount(relative[2] ?? '');
    const spelled = relative[3] !== undefined && relative[3].length > 2;
    const prefixed = relative[1] !== undefined || relative[4] !== undefined;
    const isWord = relative[2] === 'a' || relative[2] === 'an';
    if (
      unit !== undefined &&
      Number.isFinite(count) &&
      (!isWord || prefixed) &&
      (spelled || prefixed || !input.includes(' '))
    ) {
      return shift(base, count, unit);
    }
  }

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(input);
  if (iso !== null) {
    return calendarDay(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }

  const monthFirst = /^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(
    input
  );
  if (monthFirst !== null) {
    const month = MONTHS[monthFirst[1] ?? ''];
    if (month !== undefined) {
      return monthDay(base, month, Number(monthFirst[2]), monthFirst[3]);
    }
  }

  const dayFirstWords =
    /^(\d{1,2})(?:st|nd|rd|th)?(?: of)? ([a-z]+)(?: (\d{4}))?$/.exec(input);
  if (dayFirstWords !== null) {
    const month = MONTHS[dayFirstWords[2] ?? ''];
    if (month !== undefined) {
      return monthDay(base, month, Number(dayFirstWords[1]), dayFirstWords[3]);
    }
  }

  const numeric = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2}|\d{4}))?$/.exec(input);
  if (numeric !== null) {
    const dayFirst = options.dayFirst ?? localeDayFirst();
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    const month = (dayFirst ? second : first) - 1;
    const date = dayFirst ? first : second;
    return monthDay(base, month, date, numeric[3]);
  }

  return null;
};
