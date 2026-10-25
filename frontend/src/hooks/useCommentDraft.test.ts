/**
 * The composer's draft hook. Covers that a saved draft for the thread is put
 * back into an empty editor, that typing saves after a pause rather than per
 * keystroke, that emptying the text discards the draft, that posting discards
 * it at once, and that a reply thread only restores its own draft.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RichMarkdownHandle } from '../components/editor/RichMarkdownEditor';
import type { DraftRead } from '../types/Api';
import { DRAFT_SAVE_DELAY_MS, useCommentDraft } from './useCommentDraft';

const listIssueDrafts = vi.fn<() => Promise<DraftRead[]>>();
const saveDraft =
  vi.fn<
    (parent: string | null | undefined, body: string) => Promise<DraftRead>
  >();
const deleteDraft =
  vi.fn<(parent: string | null | undefined) => Promise<void>>();

vi.mock('../api/drafts', () => ({
  listIssueDrafts: () => listIssueDrafts(),
  saveDraft: (_w: string, _i: string, parent: string | null, body: string) =>
    saveDraft(parent, body),
  deleteDraft: (_w: string, _i: string, parent: string | null) =>
    deleteDraft(parent),
}));

/** A saved draft row for the thread given. */
const row = (body: string, parent: string | null = null): DraftRead => ({
  issue_id: 'iss-1',
  parent_comment_id: parent,
  team_id: 'team-1',
  body,
  created_at: '2026-10-23T00:00:00Z',
  updated_at: '2026-10-23T00:00:00Z',
});

/** A stand in editor handle whose text the test can read back. */
const handle = (initial = ''): RichMarkdownHandle & { text: string } => {
  const editor = {
    text: initial,
    focus: vi.fn(),
    getMarkdown: () => editor.text,
    setMarkdown: (markdown: string) => {
      editor.text = markdown;
    },
    insertFiles: vi.fn(),
    appendMarkdown: vi.fn(),
    passageAt: () => null,
  };
  return editor;
};

/** Renders the hook for one thread with a fresh editor ref. */
const mount = (parent?: string) => {
  const editorRef: { current: RichMarkdownHandle | null } = { current: null };
  return renderHook(() => useCommentDraft('ws-1', 'iss-1', parent, editorRef));
};

describe('useCommentDraft', () => {
  beforeEach(() => {
    listIssueDrafts.mockReset();
    saveDraft.mockReset();
    deleteDraft.mockReset();
    saveDraft.mockResolvedValue(row('saved'));
    deleteDraft.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('restores the saved draft into an empty editor', async () => {
    listIssueDrafts.mockResolvedValue([row('Half a thought')]);
    const editor = handle();
    const { result } = mount();

    act(() => {
      result.current.ref(editor);
    });

    await waitFor(() => {
      expect(editor.text).toBe('Half a thought');
    });
  });

  it('restores only the reply thread its own draft', async () => {
    listIssueDrafts.mockResolvedValue([
      row('On the issue'),
      row('On the reply', 'c-1'),
    ]);
    const editor = handle();
    const { result } = mount('c-1');

    act(() => {
      result.current.ref(editor);
    });

    await waitFor(() => {
      expect(editor.text).toBe('On the reply');
    });
  });

  it('leaves text typed before the draft arrived alone', async () => {
    let answer: (rows: DraftRead[]) => void = () => undefined;
    listIssueDrafts.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    const editor = handle();
    const { result } = mount();

    act(() => {
      result.current.ref(editor);
      editor.text = 'Typed first';
      result.current.save('Typed first');
    });
    await act(async () => {
      answer([row('Older draft')]);
      await Promise.resolve();
    });

    expect(editor.text).toBe('Typed first');
  });

  it('saves after a pause, once, with the latest text', () => {
    listIssueDrafts.mockResolvedValue([]);
    vi.useFakeTimers();
    const { result } = mount();

    act(() => {
      result.current.save('H');
      result.current.save('Hello');
    });
    expect(saveDraft).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    });

    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(saveDraft).toHaveBeenCalledWith(null, 'Hello');
  });

  it('discards the draft when the text is emptied', () => {
    listIssueDrafts.mockResolvedValue([]);
    vi.useFakeTimers();
    const { result } = mount('c-1');

    act(() => {
      result.current.save('Hello');
      vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    });
    act(() => {
      result.current.save('   ');
      vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    });

    expect(deleteDraft).toHaveBeenCalledWith('c-1');
  });

  it('discards at once on post and saves nothing pending', () => {
    listIssueDrafts.mockResolvedValue([]);
    vi.useFakeTimers();
    const { result } = mount();

    act(() => {
      result.current.save('Posting this');
      result.current.clear();
      result.current.save('');
      vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    });

    expect(deleteDraft).toHaveBeenCalledTimes(1);
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('saves pending text when the composer closes', () => {
    listIssueDrafts.mockResolvedValue([]);
    vi.useFakeTimers();
    const { result, unmount } = mount();

    act(() => {
      result.current.save('Closing mid thought');
    });
    unmount();

    expect(saveDraft).toHaveBeenCalledWith(null, 'Closing mid thought');
  });
});
