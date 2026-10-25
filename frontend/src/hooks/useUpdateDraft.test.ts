/**
 * The update composer's draft hook. Covers that a saved draft is put back with
 * its health on a project and on an initiative, that typing saves the text and
 * health after a pause, that emptying the text or putting the template back
 * discards the draft, that posting discards it at once, and that an editor
 * with no target keeps no draft.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateDraftTarget } from '../api/drafts';
import type { RichMarkdownHandle } from '../components/editor/RichMarkdownEditor';
import type { UpdateDraftRead, UpdateDraftWrite } from '../types/Api';
import { DRAFT_SAVE_DELAY_MS } from './useCommentDraft';
import { useUpdateDraft } from './useUpdateDraft';

const getUpdateDraft =
  vi.fn<(target: UpdateDraftTarget) => Promise<UpdateDraftRead | null>>();
const saveUpdateDraft =
  vi.fn<
    (
      target: UpdateDraftTarget,
      write: UpdateDraftWrite
    ) => Promise<UpdateDraftRead>
  >();
const deleteUpdateDraft = vi.fn<(target: UpdateDraftTarget) => Promise<void>>();

vi.mock('../api/drafts', () => ({
  getUpdateDraft: (target: UpdateDraftTarget) => getUpdateDraft(target),
  saveUpdateDraft: (target: UpdateDraftTarget, write: UpdateDraftWrite) =>
    saveUpdateDraft(target, write),
  deleteUpdateDraft: (target: UpdateDraftTarget) => deleteUpdateDraft(target),
}));

const PROJECT: UpdateDraftTarget = {
  workspaceId: 'ws-1',
  kind: 'project',
  id: 'prj-1',
};

const INITIATIVE: UpdateDraftTarget = {
  workspaceId: 'ws-1',
  kind: 'initiative',
  id: 'ini-1',
};

/** A saved draft row on the target given. */
const row = (
  body: string,
  target: UpdateDraftTarget = PROJECT,
  health: UpdateDraftRead['health'] = 'at_risk'
): UpdateDraftRead => ({
  target_kind: target.kind,
  project_id: target.kind === 'project' ? target.id : null,
  initiative_id: target.kind === 'initiative' ? target.id : null,
  target_name: 'Target',
  body,
  health,
  created_at: '2026-10-25T00:00:00Z',
  updated_at: '2026-10-25T00:00:00Z',
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

/** Renders the hook for one target with a fresh editor ref. */
const mount = (
  target: UpdateDraftTarget | undefined,
  options: Parameters<typeof useUpdateDraft>[2] = {}
) => {
  const editorRef: { current: RichMarkdownHandle | null } = { current: null };
  return renderHook(() => useUpdateDraft(target, editorRef, options));
};

describe('useUpdateDraft', () => {
  beforeEach(() => {
    getUpdateDraft.mockReset();
    saveUpdateDraft.mockReset();
    deleteUpdateDraft.mockReset();
    saveUpdateDraft.mockResolvedValue(row('saved'));
    deleteUpdateDraft.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('restores a project draft and its health into an empty editor', async () => {
    getUpdateDraft.mockResolvedValue(row('Half an update'));
    const onRestore = vi.fn();
    const editor = handle();
    const { result } = mount(PROJECT, { onRestore });

    act(() => {
      result.current.ref(editor);
    });

    await waitFor(() => {
      expect(editor.text).toBe('Half an update');
    });
    expect(getUpdateDraft).toHaveBeenCalledWith(PROJECT);
    expect(onRestore).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Half an update', health: 'at_risk' })
    );
  });

  it('restores an initiative draft over the template it opened on', async () => {
    getUpdateDraft.mockResolvedValue(
      row('Initiative words', INITIATIVE, 'off_track')
    );
    const editor = handle('## Template');
    const { result } = mount(INITIATIVE, { initialBody: '## Template' });

    act(() => {
      result.current.ref(editor);
    });

    await waitFor(() => {
      expect(editor.text).toBe('Initiative words');
    });
    expect(getUpdateDraft).toHaveBeenCalledWith(INITIATIVE);
  });

  it('saves the text and health after a pause', () => {
    getUpdateDraft.mockResolvedValue(null);
    vi.useFakeTimers();
    const { result } = mount(PROJECT);

    act(() => {
      result.current.ref(handle());
      result.current.save('On');
      result.current.save('On track');
      result.current.pickHealth('on_track');
    });
    expect(saveUpdateDraft).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    });

    expect(saveUpdateDraft).toHaveBeenCalledTimes(1);
    expect(saveUpdateDraft).toHaveBeenCalledWith(PROJECT, {
      body: 'On track',
      health: 'on_track',
    });
  });

  it('discards the draft when the text is emptied or the template put back', () => {
    getUpdateDraft.mockResolvedValue(null);
    vi.useFakeTimers();
    const { result } = mount(PROJECT, { initialBody: '## Template' });

    act(() => {
      result.current.ref(handle('## Template'));
      result.current.save('## Template\nWords');
      vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    });
    act(() => {
      result.current.save('## Template');
      vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    });

    expect(saveUpdateDraft).toHaveBeenCalledTimes(1);
    expect(deleteUpdateDraft).toHaveBeenCalledWith(PROJECT);
  });

  it('clears the draft at once when the update posts', () => {
    getUpdateDraft.mockResolvedValue(null);
    vi.useFakeTimers();
    const { result } = mount(INITIATIVE);

    act(() => {
      result.current.ref(handle());
      result.current.save('Posting this');
      result.current.clear();
      vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    });

    expect(deleteUpdateDraft).toHaveBeenCalledWith(INITIATIVE);
    expect(saveUpdateDraft).not.toHaveBeenCalled();
  });

  it('keeps no draft without a target', () => {
    vi.useFakeTimers();
    const { result } = mount(undefined);

    act(() => {
      result.current.ref(handle());
      result.current.save('Editing a posted update');
      result.current.pickHealth('at_risk');
      result.current.clear();
      vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    });

    expect(getUpdateDraft).not.toHaveBeenCalled();
    expect(saveUpdateDraft).not.toHaveBeenCalled();
    expect(deleteUpdateDraft).not.toHaveBeenCalled();
  });
});
