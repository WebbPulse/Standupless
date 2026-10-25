/**
 * The saved new issue draft: scoped per workspace and viewer, read back only
 * when it has the right shape, written without placeholders for files that
 * never uploaded, and harmless when storage refuses.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearIssueDraft,
  issueDraftStorageKey,
  readIssueDraft,
  useHasIssueDraft,
  writeIssueDraft,
  type IssueDraft,
} from './issueDraft';

const draft: IssueDraft = {
  teamId: 't-1',
  title: 'Fix login',
  body: 'Steps',
  templateId: null,
  templateTitle: '',
  templateBody: '',
  answers: {},
  statusId: 'st-2',
  priority: 'high',
  assigneeId: 'u-1',
  labelIds: ['lb-1'],
  estimate: '3',
  projectId: 'p-1',
  projectMilestoneId: 'm-1',
  cycleId: 'c-1',
  startDate: null,
  dueDate: '2026-11-01',
  parent: { id: 'i-1', key: 'ENG-1', title: 'Parent' },
  subIssues: ['First', ''],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('issueDraftStorageKey', () => {
  it('needs both a workspace and a viewer', () => {
    expect(issueDraftStorageKey('ws-1', 'u-1')).toBe(
      'standupless.issueDraft.ws-1.u-1'
    );
    expect(issueDraftStorageKey('', 'u-1')).toBeNull();
    expect(issueDraftStorageKey('ws-1', undefined)).toBeNull();
    expect(issueDraftStorageKey('ws-1', null)).toBeNull();
  });
});

describe('reading and writing', () => {
  it('round trips a draft, dropping empty sub-issue rows', () => {
    expect(writeIssueDraft('ws-1', 'u-1', draft)).toBe(true);
    expect(readIssueDraft('ws-1', 'u-1')).toEqual({
      ...draft,
      subIssues: ['First'],
    });
  });

  it('keeps each workspace and viewer apart', () => {
    writeIssueDraft('ws-1', 'u-1', draft);
    expect(readIssueDraft('ws-2', 'u-1')).toBeNull();
    expect(readIssueDraft('ws-1', 'u-2')).toBeNull();
  });

  it('takes out placeholders for files that never uploaded', () => {
    writeIssueDraft('ws-1', 'u-1', {
      ...draft,
      body: 'Before\n\n![shot.png](pending-upload:file-1)\n\nAfter',
    });
    expect(readIssueDraft('ws-1', 'u-1')?.body).toBe('Before\n\nAfter');
  });

  it('reads something malformed as no draft', () => {
    globalThis.localStorage.setItem(
      'standupless.issueDraft.ws-1.u-1',
      JSON.stringify({ ...draft, priority: 'whenever' })
    );
    expect(readIssueDraft('ws-1', 'u-1')).toBeNull();
    globalThis.localStorage.setItem('standupless.issueDraft.ws-1.u-1', '{');
    expect(readIssueDraft('ws-1', 'u-1')).toBeNull();
  });

  it('clears a draft', () => {
    writeIssueDraft('ws-1', 'u-1', draft);
    clearIssueDraft('ws-1', 'u-1');
    expect(readIssueDraft('ws-1', 'u-1')).toBeNull();
  });

  it('reports a refused write and survives a refused read', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(writeIssueDraft('ws-1', 'u-1', draft)).toBe(false);
    expect(readIssueDraft('ws-1', 'u-1')).toBeNull();
    expect(() => {
      clearIssueDraft('ws-1', 'u-1');
    }).not.toThrow();
  });

  it('refuses without a viewer', () => {
    expect(writeIssueDraft('ws-1', undefined, draft)).toBe(false);
  });
});

describe('useHasIssueDraft', () => {
  it('follows drafts as they are written and cleared', () => {
    const { result } = renderHook(() => useHasIssueDraft('ws-1', 'u-1'));
    expect(result.current).toBe(false);

    act(() => {
      writeIssueDraft('ws-1', 'u-1', draft);
    });
    expect(result.current).toBe(true);

    act(() => {
      clearIssueDraft('ws-1', 'u-1');
    });
    expect(result.current).toBe(false);
  });
});
