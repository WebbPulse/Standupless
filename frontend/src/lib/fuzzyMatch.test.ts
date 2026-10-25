/**
 * The palette's fuzzy scorer: the tiers a word reaches, the typos it forgives,
 * the order ties keep, the label runs it hands back for highlighting, and that
 * ranking a list costs work linear in its rows.
 */

import { describe, expect, it } from 'vitest';
import { fuzzyMatch, rankRows, scoreWord } from './fuzzyMatch';

const scoreOf = (label: string, query: string, extras: string[] = []) =>
  fuzzyMatch(label, extras, query).score;

describe('fuzzyMatch', () => {
  it('matches everything on an empty query', () => {
    expect(scoreOf('Inbox', '')).toBeGreaterThan(0);
    expect(scoreOf('Inbox', '   ')).toBeGreaterThan(0);
  });

  it('finds abbreviations the way Linear does', () => {
    expect(scoreOf('Assign to me', 'asgn me')).toBeGreaterThan(0);
    expect(scoreOf('Change status', 'chst')).toBeGreaterThan(0);
    expect(scoreOf('Change status', 'cs')).toBeGreaterThan(0);
  });

  it('ranks a prefix over a word prefix over initials over a substring over a subsequence', () => {
    const prefix = scoreWord('status page', 'sta')?.score ?? 0;
    const wordPrefix = scoreWord('change status', 'sta')?.score ?? 0;
    const initials = scoreWord('change status', 'cs')?.score ?? 0;
    const substring = scoreWord('the restart', 'sta')?.score ?? 0;
    const subsequence = scoreWord('change status', 'chst')?.score ?? 0;

    expect(prefix).toBeGreaterThan(wordPrefix);
    expect(wordPrefix).toBeGreaterThan(initials);
    expect(initials).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(subsequence);
    expect(subsequence).toBeGreaterThan(0);
  });

  it('needs a subsequence to start on a word and jump only to word starts', () => {
    expect(scoreOf('Change status', 'hst')).toBe(0);
    expect(scoreOf('Change status', 'cnt')).toBe(0);
  });

  it('forgives one transposed or extra character in a word of four or more', () => {
    expect(scoreOf('Roadmap', 'raodmap')).toBeGreaterThan(0);
    expect(scoreOf('Notification settings', 'ntoif')).toBeGreaterThan(0);
    expect(scoreOf('Roadmap', 'roadxmap')).toBeGreaterThan(0);
    expect(scoreOf('Roadmap', 'rdoa')).toBeGreaterThan(0);
    expect(scoreOf('Inbox', 'ibn')).toBe(0);
  });

  it('ranks an exact match over a typo', () => {
    expect(scoreOf('Roadmap', 'roadmap')).toBeGreaterThan(
      scoreOf('Roadmap', 'raodmap')
    );
  });

  it('needs every word, in the label or the extras, any order', () => {
    expect(scoreOf('SLA settings', 'team sla', ['team sla'])).toBeGreaterThan(
      0
    );
    expect(scoreOf('SLA settings', 'sla billing', ['team sla'])).toBe(0);
  });

  it('weighs the label over the extras', () => {
    expect(scoreOf('Inbox', 'inbox')).toBeGreaterThan(
      scoreOf('Notifications', 'inbox', ['inbox'])
    );
  });

  it('hands back merged label runs for highlighting', () => {
    expect(fuzzyMatch('Change status', [], 'chst').ranges).toEqual([
      [0, 2],
      [7, 9],
    ]);
    expect(fuzzyMatch('Roadmap', [], 'road').ranges).toEqual([[0, 4]]);
    expect(fuzzyMatch('Inbox', ['mail'], 'mail').ranges).toEqual([]);
  });

  it('is deterministic', () => {
    const first = fuzzyMatch('Create issue from template', ['new'], 'cr tmpl');
    const second = fuzzyMatch('Create issue from template', ['new'], 'cr tmpl');
    expect(second).toEqual(first);
  });
});

describe('rankRows', () => {
  const labels = (rows: { row: string }[]) => rows.map(({ row }) => row);
  const rank = (rows: string[], query: string) =>
    labels(
      rankRows(
        rows,
        query,
        (row) => row,
        () => []
      )
    );

  it('keeps every row in order on an empty query', () => {
    expect(rank(['Zeta', 'Alpha'], '')).toEqual(['Zeta', 'Alpha']);
  });

  it('puts the best match first and drops rows that score zero', () => {
    expect(
      rank(['Open view', 'Inbox', 'Views', 'Create view'], 'view')
    ).toEqual(['Views', 'Open view', 'Create view']);
  });

  it('breaks ties on the order the rows came in', () => {
    expect(rank(['Remove label Bug', 'Add label Infra'], 'label')).toEqual([
      'Remove label Bug',
      'Add label Infra',
    ]);
  });

  it('costs work linear in the rows', () => {
    const words = ['change', 'status', 'assign', 'priority', 'label', 'cycle'];
    const rowsOf = (count: number) =>
      Array.from(
        { length: count },
        (_, index) =>
          `${words[index % words.length] ?? ''} ${words[(index * 7) % words.length] ?? ''} row ${String(index)}`
      );
    const timeOf = (rows: string[]) => {
      const runs: number[] = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const started = performance.now();
        rankRows(
          rows,
          'chst prio',
          (row) => row,
          () => ['keywords for the row']
        );
        runs.push(performance.now() - started);
      }
      runs.sort((left, right) => left - right);
      return runs[2] ?? 0;
    };
    const small = rowsOf(1000);
    const large = rowsOf(4000);
    timeOf(small);
    timeOf(large);

    const ratio = timeOf(large) / Math.max(timeOf(small), 0.05);

    expect(ratio).toBeLessThan(10);
  });
});
