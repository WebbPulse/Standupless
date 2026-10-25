/** CSV cells are quoted when needed and never start a formula. */

import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from './csv';

describe('csv', () => {
  it('leaves a plain cell alone', () => {
    expect(csvCell('Ada Lovelace')).toBe('Ada Lovelace');
  });

  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('one\ntwo')).toBe('"one\ntwo"');
  });

  it('defuses a cell a spreadsheet would run', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('@cmd')).toBe("'@cmd");
  });

  it('joins rows with CRLF', () => {
    expect(
      toCsv([
        ['name', 'role'],
        ['Ada', 'admin'],
      ])
    ).toBe('name,role\r\nAda,admin\r\n');
  });
});
