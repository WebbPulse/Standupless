/**
 * The new issue drafts: held in a per workspace and per viewer outbox until
 * the server confirms them, merged with what the server lists, sent without
 * placeholders for files that never uploaded, kept through a refused or
 * failed save, and the single draft an earlier version kept moved in once.
 */

import { ApiError } from '@webbpulse/api-client';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  discardIssueDraft,
  flushIssueDrafts,
  issueDraftOfRead,
  issueDraftOutboxKey,
  issueDraftStorageKey,
  issueDraftWrite,
  migrateLegacyIssueDraft,
  readIssueDrafts,
  refreshIssueDrafts,
  resetIssueDraftCache,
  stashIssueDraft,
  uploadIssueDraft,
  useIssueDrafts,
  type IssueDraft,
} from './issueDraft';
import { pendingPath } from './draftUploads';
import type { IssueDraftRead, IssueDraftWrite } from '../types/Api';

const list = vi.fn<() => Promise<IssueDraftRead[]>>();
const save =
  vi.fn<(draftId: string, write: IssueDraftWrite) => Promise<IssueDraftRead>>();
const remove = vi.fn<(draftId: string) => Promise<void>>();

vi.mock('../api/newIssueDrafts', () => ({
  listNewIssueDrafts: () => list(),
  saveNewIssueDraft: (_w: string, draftId: string, write: IssueDraftWrite) =>
    save(draftId, write),
  deleteNewIssueDraft: (_w: string, draftId: string) => remove(draftId),
}));

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

/** The server's answer to a save of one draft. */
const readOf = (
  draftId: string,
  write: IssueDraftWrite,
  updatedAt = '2026-10-25T00:00:00Z'
): IssueDraftRead => ({
  ...write,
  draft_id: draftId,
  title: write.title ?? '',
  body: write.body ?? '',
  created_at: updatedAt,
  updated_at: updatedAt,
});

beforeEach(() => {
  resetIssueDraftCache();
  list.mockReset();
  save.mockReset();
  remove.mockReset();
  list.mockResolvedValue([]);
  save.mockImplementation((draftId, write) =>
    Promise.resolve(readOf(draftId, write))
  );
  remove.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('storage keys', () => {
  it('need both a workspace and a viewer', () => {
    expect(issueDraftOutboxKey('ws-1', 'u-1')).toBe(
      'standupless.issueDrafts.ws-1.u-1'
    );
    expect(issueDraftStorageKey('ws-1', 'u-1')).toBe(
      'standupless.issueDraft.ws-1.u-1'
    );
    expect(issueDraftOutboxKey('', 'u-1')).toBeNull();
    expect(issueDraftOutboxKey('ws-1', undefined)).toBeNull();
    expect(issueDraftOutboxKey('ws-1', null)).toBeNull();
  });
});

describe('the wire shape', () => {
  it('round trips every field, with no status as the default', () => {
    const write = issueDraftWrite({ ...draft, statusId: '' });
    expect(write).toMatchObject({
      team_id: 't-1',
      status_id: null,
      parent_id: 'i-1',
      parent_key: 'ENG-1',
      parent_title: 'Parent',
      due_date: '2026-11-01',
    });
    expect(issueDraftOfRead(readOf('d-1', write)).draft).toEqual({
      ...draft,
      statusId: '',
    });
  });
});

describe('the outbox', () => {
  it('holds a draft until the server confirms it, dropping empty rows', async () => {
    expect(stashIssueDraft('ws-1', 'u-1', 'd-1', draft)).toBe(true);
    expect(readIssueDrafts('ws-1', 'u-1')).toEqual([
      expect.objectContaining({
        id: 'd-1',
        draft: { ...draft, subIssues: ['First'] },
      }),
    ]);

    await expect(uploadIssueDraft('ws-1', 'u-1', 'd-1')).resolves.toBe('saved');
    expect(save).toHaveBeenCalledWith(
      'd-1',
      expect.objectContaining({ title: 'Fix login', sub_issues: ['First'] })
    );
    expect(
      globalThis.localStorage.getItem('standupless.issueDrafts.ws-1.u-1')
    ).toBeNull();
    expect(readIssueDrafts('ws-1', 'u-1')).toHaveLength(1);
  });

  it('keeps each workspace and viewer apart', () => {
    stashIssueDraft('ws-1', 'u-1', 'd-1', draft);
    expect(readIssueDrafts('ws-2', 'u-1')).toEqual([]);
    expect(readIssueDrafts('ws-1', 'u-2')).toEqual([]);
  });

  it('takes out placeholders for files that never uploaded', () => {
    stashIssueDraft('ws-1', 'u-1', 'd-1', {
      ...draft,
      body: `Before\n\n![shot.png](${pendingPath('ws-1', 'file-1', 'image')})\n\nAfter`,
    });
    expect(readIssueDrafts('ws-1', 'u-1')[0]?.draft.body).toBe(
      'Before\n\nAfter'
    );
  });

  it('keeps the draft held when the save fails or the cap is reached', async () => {
    stashIssueDraft('ws-1', 'u-1', 'd-1', draft);
    save.mockRejectedValueOnce(new Error('offline'));
    await expect(uploadIssueDraft('ws-1', 'u-1', 'd-1')).resolves.toBe(
      'failed'
    );
    save.mockRejectedValueOnce(
      new ApiError({
        status: 409,
        statusText: 'Conflict',
        body: null,
        url: '/api/workspaces/ws-1/drafts/new-issues/d-1',
        method: 'PUT',
      })
    );
    await expect(uploadIssueDraft('ws-1', 'u-1', 'd-1')).resolves.toBe('limit');
    expect(readIssueDrafts('ws-1', 'u-1')).toHaveLength(1);

    await flushIssueDrafts('ws-1', 'u-1');
    expect(
      globalThis.localStorage.getItem('standupless.issueDrafts.ws-1.u-1')
    ).toBeNull();
  });

  it('discards at once and sends the discard', async () => {
    stashIssueDraft('ws-1', 'u-1', 'd-1', draft);
    await uploadIssueDraft('ws-1', 'u-1', 'd-1');

    discardIssueDraft('ws-1', 'u-1', 'd-1');
    expect(readIssueDrafts('ws-1', 'u-1')).toEqual([]);
    await flushIssueDrafts('ws-1', 'u-1');
    expect(remove).toHaveBeenCalledWith('d-1');
  });

  it('treats a draft emptied of text as a discard', () => {
    stashIssueDraft('ws-1', 'u-1', 'd-1', draft);
    stashIssueDraft('ws-1', 'u-1', 'd-1', {
      ...draft,
      title: ' ',
      body: '',
      subIssues: [],
    });
    expect(readIssueDrafts('ws-1', 'u-1')).toEqual([]);
  });

  it('reports a refused write and survives a refused read', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(stashIssueDraft('ws-1', 'u-1', 'd-1', draft)).toBe(false);
    expect(readIssueDrafts('ws-1', 'u-1')).toEqual([]);
    expect(() => {
      discardIssueDraft('ws-1', 'u-1', 'd-1');
    }).not.toThrow();
  });

  it('refuses without a viewer', () => {
    expect(stashIssueDraft('ws-1', undefined, 'd-1', draft)).toBe(false);
  });
});

describe('the server list', () => {
  it('lists newest first, with held changes over what the server sent', async () => {
    list.mockResolvedValue([
      readOf(
        'd-old',
        issueDraftWrite({ ...draft, title: 'Old' }),
        '2026-10-01T00:00:00Z'
      ),
      readOf(
        'd-mid',
        issueDraftWrite({ ...draft, title: 'Mid' }),
        '2026-10-10T00:00:00Z'
      ),
    ]);
    await refreshIssueDrafts('ws-1', 'u-1');
    stashIssueDraft('ws-1', 'u-1', 'd-old', { ...draft, title: 'Old, edited' });

    expect(
      readIssueDrafts('ws-1', 'u-1').map((saved) => saved.draft.title)
    ).toEqual(['Old, edited', 'Mid']);
  });

  it('keeps what it knew when the list fails', async () => {
    list.mockResolvedValueOnce([readOf('d-1', issueDraftWrite(draft))]);
    await refreshIssueDrafts('ws-1', 'u-1');
    list.mockRejectedValueOnce(new Error('offline'));
    await refreshIssueDrafts('ws-1', 'u-1');
    expect(readIssueDrafts('ws-1', 'u-1')).toHaveLength(1);
  });
});

describe('migrateLegacyIssueDraft', () => {
  it('moves the earlier single draft in once, then clears it', () => {
    globalThis.localStorage.setItem(
      'standupless.issueDraft.ws-1.u-1',
      JSON.stringify(draft)
    );
    migrateLegacyIssueDraft('ws-1', 'u-1');
    migrateLegacyIssueDraft('ws-1', 'u-1');

    expect(
      globalThis.localStorage.getItem('standupless.issueDraft.ws-1.u-1')
    ).toBeNull();
    expect(readIssueDrafts('ws-1', 'u-1')).toEqual([
      expect.objectContaining({ draft: { ...draft, subIssues: ['First'] } }),
    ]);
  });

  it('clears something malformed without keeping it', () => {
    globalThis.localStorage.setItem('standupless.issueDraft.ws-1.u-1', '{');
    migrateLegacyIssueDraft('ws-1', 'u-1');
    expect(
      globalThis.localStorage.getItem('standupless.issueDraft.ws-1.u-1')
    ).toBeNull();
    expect(readIssueDrafts('ws-1', 'u-1')).toEqual([]);
  });
});

describe('useIssueDrafts', () => {
  it('follows drafts as they are held and discarded', () => {
    const { result } = renderHook(() => useIssueDrafts('ws-1', 'u-1'));
    expect(result.current).toEqual([]);

    act(() => {
      stashIssueDraft('ws-1', 'u-1', 'd-1', draft);
    });
    expect(result.current).toHaveLength(1);

    act(() => {
      discardIssueDraft('ws-1', 'u-1', 'd-1');
    });
    expect(result.current).toEqual([]);
  });
});
