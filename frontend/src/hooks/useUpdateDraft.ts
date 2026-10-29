/**
 * The status update composer's server side draft, the counterpart of
 * {@link useCommentDraft} for a project or initiative update. Restores the
 * caller's saved text and health when the composer opens, saves after the same
 * pause comments use, discards the draft when the text is emptied or put back
 * to the template it opened on, and discards it at once when the update posts.
 * An editor with no target, such as one editing a posted update, keeps no
 * draft and the hook does nothing.
 */

import { type RefObject, useCallback, useEffect, useRef } from 'react';
import {
  type UpdateDraftTarget,
  deleteUpdateDraft,
  getUpdateDraft,
  saveUpdateDraft,
} from '../api/drafts';
import type { RichMarkdownHandle } from '../components/editor/RichMarkdownEditor';
import type { ProjectHealth, UpdateDraftRead } from '../types/Api';
import { DRAFT_SAVE_DELAY_MS } from './useCommentDraft';

/** What the update composer wires into its editor and health chooser. */
export interface UpdateDraft {
  /** The editor ref, which also restores the saved draft once both are ready. */
  ref: (handle: RichMarkdownHandle | null) => void;
  /** Records the editor's text, saving it after a pause. */
  save: (markdown: string) => void;
  /** Records the health picked, saving it after a pause. */
  pickHealth: (health: ProjectHealth) => void;
  /** Discards the draft now, for an update that just posted. */
  clear: () => void;
}

/** Options for {@link useUpdateDraft}. */
export interface UpdateDraftOptions {
  /** The text the editor opens with, such as a template body, which is never kept as a draft. */
  initialBody?: string;
  /** Called with the draft once it is put back, so the composer can show its health. */
  onRestore?: (draft: UpdateDraftRead) => void;
}

/** A stable key for a target, so the hook re-reads only when the target changes. */
const targetKey = (target: UpdateDraftTarget | undefined): string =>
  target === undefined
    ? ''
    : `${target.workspaceId}:${target.kind}:${target.id}`;

/** Binds one update composer to the caller's draft on a project or initiative. */
export const useUpdateDraft = (
  target: UpdateDraftTarget | undefined,
  editorRef: RefObject<RichMarkdownHandle | null>,
  { initialBody = '', onRestore }: UpdateDraftOptions = {}
): UpdateDraft => {
  const key = targetKey(target);
  const restored = useRef<UpdateDraftRead | null>(null);
  const applied = useRef(false);
  const touched = useRef(false);
  const saved = useRef<string | null>('');
  const latest = useRef(initialBody);
  const health = useRef<ProjectHealth | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef(target);
  current.current = target;
  const opening = useRef(initialBody);
  opening.current = initialBody;
  const restoreHandler = useRef(onRestore);
  restoreHandler.current = onRestore;

  const write = useCallback((): void => {
    const where = current.current;
    if (where === undefined) return;
    const text = latest.current;
    const blank = text.trim() === '' || text.trim() === opening.current.trim();
    const body = blank ? '' : text;
    const signature = body === '' ? '' : `${health.current ?? ''}\n${body}`;
    if (signature === saved.current) return;
    saved.current = signature;
    const request =
      body === ''
        ? deleteUpdateDraft(where)
        : saveUpdateDraft(where, { body, health: health.current }).then(
            () => undefined
          );
    request.catch(() => {
      if (saved.current === signature) saved.current = null;
    });
  }, []);

  const cancel = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  const schedule = useCallback((): void => {
    cancel();
    timer.current = setTimeout(() => {
      timer.current = null;
      write();
    }, DRAFT_SAVE_DELAY_MS);
  }, [write]);

  const restore = useCallback((): void => {
    const handle = editorRef.current;
    const draft = restored.current;
    if (applied.current || handle === null || draft === null) return;
    applied.current = true;
    if (touched.current) return;
    if (handle.getMarkdown().trim() !== opening.current.trim()) return;
    health.current = draft.health ?? null;
    saved.current = `${health.current ?? ''}\n${draft.body}`;
    latest.current = draft.body;
    handle.setMarkdown(draft.body);
    restoreHandler.current?.(draft);
  }, [editorRef]);

  useEffect(() => {
    const where = current.current;
    if (where === undefined) return;
    const controller = new AbortController();
    restored.current = null;
    applied.current = false;
    getUpdateDraft(where, controller.signal)
      .then((draft) => {
        if (draft === null || draft.body.trim() === '') return;
        restored.current = draft;
        restore();
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [key, restore]);

  useEffect(
    () => () => {
      if (timer.current === null) return;
      cancel();
      write();
    },
    [write]
  );

  const ref = useCallback(
    (handle: RichMarkdownHandle | null): void => {
      editorRef.current = handle;
      restore();
    },
    [editorRef, restore]
  );

  const save = useCallback(
    (markdown: string): void => {
      if (current.current === undefined) return;
      if (markdown === latest.current) return;
      latest.current = markdown;
      if (markdown.trim() !== opening.current.trim()) touched.current = true;
      schedule();
    },
    [schedule]
  );

  const pickHealth = useCallback(
    (picked: ProjectHealth): void => {
      if (current.current === undefined) return;
      health.current = picked;
      touched.current = true;
      schedule();
    },
    [schedule]
  );

  const clear = useCallback((): void => {
    cancel();
    latest.current = '';
    saved.current = '';
    const where = current.current;
    if (where === undefined) return;
    deleteUpdateDraft(where).catch(() => undefined);
  }, []);

  return { ref, save, pickHealth, clear };
};

export default useUpdateDraft;
