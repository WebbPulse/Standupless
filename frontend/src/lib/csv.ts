/**
 * Building CSV text in the browser, for exports read from a list the page
 * already holds. Cells follow RFC 4180 quoting, and a cell a spreadsheet would
 * read as a formula is prefixed with an apostrophe so opening the file runs
 * nothing.
 */

const FORMULA_START = /^[=+\-@\t\r]/;

/** One cell, quoted when it holds a comma, quote or line break. */
export const csvCell = (value: string): string => {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The rows as CSV text with CRLF line endings, the header row first. */
export const toCsv = (rows: readonly (readonly string[])[]): string =>
  rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
