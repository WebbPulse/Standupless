/**
 * The batch read behind issue chips. Covers that mentions asked for together
 * go out as one lookup per workspace with each key once, that a long body is
 * split into chunks the route accepts, that a moved key resolves through the
 * lookup's map, that an unknown key resolves to nothing, and that a failed
 * lookup fails every mention it carried.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueLookupRead, IssueRead } from '../types/Api';
import { codeSpanIssueKey } from './issueDisplay';
import {
  loadIssueMention,
  MAX_LOOKUP_KEYS,
  MENTION_BATCH_MS,
  setMentionLookup,
} from './issueMentions';

/** A minimal issue for the lookup to answer with. */
const issueOf = (id: string, key: string): IssueRead =>
  ({ id, key, title: `Title of ${key}` }) as IssueRead;

const lookup =
  vi.fn<
    (workspaceId: string, keys: readonly string[]) => Promise<IssueLookupRead>
  >();
let restore: () => void = () => undefined;

beforeEach(() => {
  vi.useFakeTimers();
  lookup.mockReset();
  lookup.mockImplementation((_workspace, keys) =>
    Promise.resolve({
      issues: keys
        .filter((key) => key.startsWith('ENG-'))
        .map((key) => issueOf(`id-${key}`, key)),
      resolved: Object.fromEntries(
        keys
          .filter((key) => key.startsWith('ENG-'))
          .map((key) => [key, `id-${key}`])
      ),
    })
  );
  restore = setMentionLookup(lookup);
});

afterEach(() => {
  restore();
  vi.useRealTimers();
});

describe('loadIssueMention', () => {
  it('sends the mentions asked for together as one lookup', async () => {
    const asked = Promise.all([
      loadIssueMention('ws-1', 'ENG-1'),
      loadIssueMention('ws-1', 'eng-2'),
      loadIssueMention('ws-1', 'ENG-1'),
    ]);

    await vi.advanceTimersByTimeAsync(MENTION_BATCH_MS);
    const [first, second, again] = await asked;

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('ws-1', ['ENG-1', 'ENG-2']);
    expect(first?.key).toBe('ENG-1');
    expect(second?.key).toBe('ENG-2');
    expect(again).toBe(first);
  });

  it('keeps each workspace to its own lookup', async () => {
    const asked = Promise.all([
      loadIssueMention('ws-1', 'ENG-1'),
      loadIssueMention('ws-2', 'ENG-1'),
    ]);

    await vi.advanceTimersByTimeAsync(MENTION_BATCH_MS);
    await asked;

    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('splits a long body into chunks the route accepts', async () => {
    const keys = Array.from(
      { length: MAX_LOOKUP_KEYS + 5 },
      (_, index) => `ENG-${String(index + 1)}`
    );
    const asked = Promise.all(keys.map((key) => loadIssueMention('ws-1', key)));

    await vi.advanceTimersByTimeAsync(MENTION_BATCH_MS);
    const found = await asked;

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup.mock.calls[0]?.[1]).toHaveLength(MAX_LOOKUP_KEYS);
    expect(lookup.mock.calls[1]?.[1]).toHaveLength(5);
    expect(found.every((issue) => issue !== null)).toBe(true);
  });

  it('resolves a moved key through the map the lookup returns', async () => {
    lookup.mockResolvedValueOnce({
      issues: [issueOf('id-9', 'NEW-9')],
      resolved: { 'OLD-9': 'id-9' },
    });
    const asked = loadIssueMention('ws-1', 'OLD-9');

    await vi.advanceTimersByTimeAsync(MENTION_BATCH_MS);

    expect((await asked)?.key).toBe('NEW-9');
  });

  it('resolves a key naming nothing to null', async () => {
    const asked = loadIssueMention('ws-1', 'NOPE-1');

    await vi.advanceTimersByTimeAsync(MENTION_BATCH_MS);

    expect(await asked).toBeNull();
  });

  it('fails every mention a failed lookup carried', async () => {
    lookup.mockRejectedValueOnce(new Error('offline'));
    const first = loadIssueMention('ws-1', 'ENG-1');
    const second = loadIssueMention('ws-1', 'ENG-2');
    const settled = Promise.allSettled([first, second]);

    await vi.advanceTimersByTimeAsync(MENTION_BATCH_MS);

    expect((await settled).map((result) => result.status)).toEqual([
      'rejected',
      'rejected',
    ]);
  });
});

describe('codeSpanIssueKey', () => {
  it('reads a code span holding nothing but a key', () => {
    expect(codeSpanIssueKey('STUP-620')).toBe('STUP-620');
    expect(codeSpanIssueKey(' ENG-12 ')).toBe('ENG-12');
  });

  it('leaves any other code alone', () => {
    expect(codeSpanIssueKey('STUP-620 is done')).toBeNull();
    expect(codeSpanIssueKey('stup-620')).toBeNull();
    expect(codeSpanIssueKey('UTF-8x')).toBeNull();
    expect(codeSpanIssueKey('npm run build')).toBeNull();
  });
});
