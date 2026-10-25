/**
 * The composer's server side draft. Restores the caller's saved draft for the
 * thread when the composer opens, saves what they type after a short pause,
 * discards the draft when the text is emptied, and discards it at once when
 * the comment posts. Drafts are the caller's own and never notify anyone.
 * A composer that keeps no draft, such as the one pinned to a passage of the
 * description, passes `enabled` false and the hook does nothing.
 */

import { type RefObject, useCallback, useEffect, useRef } from 'react';
import {
  type CommentDraftParent,
  deleteDraft,
  listIssueDrafts,
  saveDraft,
} from '../api/drafts';
import type { RichMarkdownHandle } from '../components/editor/RichMarkdownEditor';

/** How long typing pauses before the draft is saved. */
export const DRAFT_SAVE_DELAY_MS = 800;

/** A stable string naming one parent, so the restore effect reruns only when the thread changes. */
const parentKey = (parent: CommentDraftParent): string => {
  if (parent.kind === 'project_update')
    return `project_update:${parent.projectId}:${parent.updateId}`;
  if (parent.kind === 'initiative_update')
    return `initiative_update:${parent.initiativeId}:${parent.updateId}`;
  return `${parent.kind}:${parent.id}`;
};

/** What the composer wires into its editor. */
export interface CommentDraft {
  /** The editor ref, which also restores the saved draft once both are ready. */
  ref: (handle: RichMarkdownHandle | null) => void;
  /** Records the editor's text, saving it after a pause. */
  save: (markdown: string) => void;
  /** Discards the thread's draft now, for a comment that just posted. */
  clear: () => void;
}

/** Binds one composer to the caller's draft on an issue, document or update thread, or one reply thread of it. */
export const useCommentDraft = (
  workspaceId: string,
  parent: CommentDraftParent,
  parentCommentId: string | undefined,
  editorRef: RefObject<RichMarkdownHandle | null>,
  enabled = true
): CommentDraft => {
  const thread = parentCommentId ?? null;
  const restored = useRef<string | null>(null);
  const applied = useRef(false);
  const touched = useRef(false);
  const saved = useRef<string | null>('');
  const latest = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = parentKey(parent);
  const target = useRef({ workspaceId, parent, thread });
  target.current = { workspaceId, parent, thread };
  const active = useRef(enabled);
  active.current = enabled;

  const write = useCallback((markdown: string): void => {
    if (!active.current) return;
    const body = markdown.trim() === '' ? '' : markdown;
    if (body === saved.current) return;
    const { workspaceId: ws, parent: owner, thread: reply } = target.current;
    saved.current = body;
    const request =
      body === ''
        ? deleteDraft(ws, owner, reply)
        : saveDraft(ws, owner, reply, body).then(() => undefined);
    request.catch(() => {
      if (saved.current === body) saved.current = null;
    });
  }, []);

  const cancel = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  const restore = useCallback((): void => {
    const handle = editorRef.current;
    const body = restored.current;
    if (applied.current || handle === null || body === null) return;
    applied.current = true;
    if (touched.current || handle.getMarkdown().trim() !== '') return;
    saved.current = body;
    latest.current = body;
    handle.setMarkdown(body);
  }, [editorRef]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    restored.current = null;
    applied.current = false;
    listIssueDrafts(workspaceId, target.current.parent, controller.signal)
      .then((drafts) => {
        const mine = drafts.find(
          (row) => (row.parent_comment_id ?? null) === thread
        );
        if (mine === undefined || mine.body.trim() === '') return;
        restored.current = mine.body;
        restore();
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [workspaceId, key, thread, restore, enabled]);

  useEffect(
    () => () => {
      if (timer.current === null) return;
      cancel();
      write(latest.current);
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
      latest.current = markdown;
      if (markdown.trim() !== '') touched.current = true;
      cancel();
      timer.current = setTimeout(() => {
        timer.current = null;
        write(latest.current);
      }, DRAFT_SAVE_DELAY_MS);
    },
    [write]
  );

  const clear = useCallback((): void => {
    cancel();
    latest.current = '';
    saved.current = '';
    if (!active.current) return;
    const { workspaceId: ws, parent: owner, thread: reply } = target.current;
    deleteDraft(ws, owner, reply).catch(() => undefined);
  }, []);

  return { ref, save, clear };
};
