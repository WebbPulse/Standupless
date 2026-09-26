/**
 * The composer's upload hook. Covers that a finished upload is held out of
 * the issue's rail rather than refetched into it, that a posted file stays
 * held so the rail never flashes it before the comments list takes over, and
 * that a file the draft drops or abandons is released.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { heldUploads, releaseUploads } from '../lib/pendingUploads';
import type { AttachmentRead } from '../types/Api';
import { useAttachmentUploads } from './useAttachmentUploads';

const uploadAttachment = vi.fn<() => Promise<AttachmentRead>>();
const deleteAttachment = vi.fn<() => Promise<void>>();
const invalidateQueries = vi.fn();

vi.mock('../api/discussion', () => ({
  uploadAttachment: () => uploadAttachment(),
  deleteAttachment: () => deleteAttachment(),
}));

vi.mock('@webbpulse/api-client/react', () => ({
  invalidateQueries: (...args: unknown[]) => {
    invalidateQueries(...args);
  },
}));

const attachment = (id: string): AttachmentRead => ({
  attachment_id: id,
  issue_id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  kind: 'file',
  title: 'shot.png',
  uploaded_by: 'user-1',
  created_at: '2026-09-26T00:00:00Z',
});

const file = (): File => new File(['x'], 'shot.png', { type: 'image/png' });

describe('useAttachmentUploads', () => {
  beforeEach(() => {
    uploadAttachment.mockReset();
    deleteAttachment.mockReset();
    invalidateQueries.mockReset();
    releaseUploads('iss-1', Array.from(heldUploads('iss-1')));
  });

  it('holds a finished upload out of the rail instead of refetching it', async () => {
    uploadAttachment.mockResolvedValue(attachment('att-1'));
    const { result } = renderHook(() => useAttachmentUploads('ws-1', 'iss-1'));

    act(() => {
      result.current.add([file()]);
    });

    await waitFor(() => {
      expect(heldUploads('iss-1').has('att-1')).toBe(true);
    });
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('keeps a posted upload held, even once the composer goes away', async () => {
    uploadAttachment.mockResolvedValue(attachment('att-2'));
    const { result, unmount } = renderHook(() =>
      useAttachmentUploads('ws-1', 'iss-1')
    );
    act(() => {
      result.current.add([file()]);
    });
    await waitFor(() => {
      expect(result.current.attachmentIds()).toEqual(['att-2']);
    });

    act(() => {
      result.current.reset();
    });
    unmount();

    expect(heldUploads('iss-1').has('att-2')).toBe(true);
  });

  it('releases an upload the draft drops', async () => {
    uploadAttachment.mockResolvedValue(attachment('att-3'));
    deleteAttachment.mockResolvedValue(undefined);
    const { result } = renderHook(() => useAttachmentUploads('ws-1', 'iss-1'));
    act(() => {
      result.current.add([file()]);
    });
    await waitFor(() => {
      expect(result.current.pending[0]?.status).toBe('done');
    });

    act(() => {
      result.current.remove(result.current.pending[0]?.id ?? '');
    });

    await waitFor(() => {
      expect(heldUploads('iss-1').has('att-3')).toBe(false);
    });
  });

  it('releases an unposted upload when the composer goes away', async () => {
    uploadAttachment.mockResolvedValue(attachment('att-4'));
    const { result, unmount } = renderHook(() =>
      useAttachmentUploads('ws-1', 'iss-1')
    );
    act(() => {
      result.current.add([file()]);
    });
    await waitFor(() => {
      expect(heldUploads('iss-1').has('att-4')).toBe(true);
    });

    unmount();

    expect(heldUploads('iss-1').has('att-4')).toBe(false);
  });
});
