/**
 * Comment anchors in the rich editor: the passages of a description that
 * comment threads are pinned to, drawn as a soft highlight, as Linear does.
 *
 * A passage is stored as its text plus a little of the text either side, never
 * as marks in the document, so the description's Markdown is never rewritten
 * by a comment. Finding it again reads the document as plain text, with one
 * line break between blocks, looks for every place the quote appears, and keeps
 * the one whose surroundings agree best. A passage edited away is found nowhere,
 * which the editor reports so its thread can say the text changed.
 *
 * Capturing a selection reads the same plain text, so a passage is matched in
 * exactly the form it was taken in.
 */

import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { useEffect, useRef } from 'react';
import type { CommentAnchor } from '../../types/Api';
import './commentAnchors.css';

/** The longest passage a thread may be pinned to, which the API also holds. */
export const ANCHOR_QUOTE_MAX = 1000;

/** How much surrounding text a captured passage keeps on either side. */
export const ANCHOR_CONTEXT = 32;

/** The most places a quote is weighed in, so a common word stays cheap. */
const MAX_CANDIDATES = 200;

/** One thread pinned to the description. */
export interface AnchoredThread {
  commentId: string;
  anchor: CommentAnchor;
}

/** What the editor needs to draw a description's anchored threads. */
export interface CommentAnchorsBinding {
  /** The open threads pinned to this document. */
  threads: AnchoredThread[];
  /** The thread being pointed at, whose passage is drawn stronger. */
  activeId: string | null;
  /** Hears which threads' passages were found, whenever that changes. */
  onLocated: (commentIds: string[]) => void;
}

/**
 * A document as plain text, with the document position each character came
 * from. Block breaks are a line break at position -1, since no position holds
 * them.
 */
export interface FlatText {
  text: string;
  positions: number[];
}

/** Reads a document as the plain text a passage is matched in. */
export const flatten = (doc: ProseMirrorNode): FlatText => {
  let text = '';
  const positions: number[] = [];
  const brk = (): void => {
    if (text === '' || text.endsWith('\n')) return;
    text += '\n';
    positions.push(-1);
  };
  doc.descendants((node, pos) => {
    if (node.isText) {
      const value = node.text ?? '';
      for (let index = 0; index < value.length; index += 1) {
        text += value.charAt(index);
        positions.push(pos + index);
      }
      return false;
    }
    if (node.isBlock || node.type.name === 'hardBreak') brk();
    return true;
  });
  return { text, positions };
};

/** How many characters two strings share at their ends. */
const sharedSuffix = (left: string, right: string): number => {
  let count = 0;
  while (
    count < left.length &&
    count < right.length &&
    left.charAt(left.length - 1 - count) ===
      right.charAt(right.length - 1 - count)
  ) {
    count += 1;
  }
  return count;
};

/** How many characters two strings share at their starts. */
const sharedPrefix = (left: string, right: string): number => {
  let count = 0;
  while (
    count < left.length &&
    count < right.length &&
    left.charAt(count) === right.charAt(count)
  ) {
    count += 1;
  }
  return count;
};

/**
 * Where a passage sits in the plain text, as character offsets, or null when
 * the text no longer holds it. Among repeats, the one whose neighbours match
 * the stored context best wins, and the first on a tie.
 */
export const locatePassage = (
  text: string,
  anchor: CommentAnchor
): { start: number; end: number } | null => {
  const quote = anchor.quote;
  if (quote === '') return null;
  const prefix = anchor.prefix ?? '';
  const suffix = anchor.suffix ?? '';
  let best: { start: number; score: number } | null = null;
  let from = text.indexOf(quote);
  let seen = 0;
  while (from >= 0 && seen < MAX_CANDIDATES) {
    const score =
      sharedSuffix(
        text.slice(Math.max(0, from - prefix.length), from),
        prefix
      ) +
      sharedPrefix(
        text.slice(from + quote.length, from + quote.length + suffix.length),
        suffix
      );
    if (best === null || score > best.score) best = { start: from, score };
    seen += 1;
    from = text.indexOf(quote, from + 1);
  }
  return best === null
    ? null
    : { start: best.start, end: best.start + quote.length };
};

/**
 * The passage between two document positions, trimmed, with the text either
 * side of it, or null when it holds no text. A passage past the cap keeps its
 * opening part.
 */
export const capturePassage = (
  doc: ProseMirrorNode,
  from: number,
  to: number
): CommentAnchor | null => {
  const { text, positions } = flatten(doc);
  let start = positions.findIndex((pos) => pos >= from);
  if (start < 0) return null;
  let end = start;
  for (let index = start; index < positions.length; index += 1) {
    const pos = positions[index] ?? -1;
    if (pos >= to) break;
    if (pos >= 0) end = index + 1;
  }
  while (start < end && /\s/.test(text.charAt(start))) start += 1;
  while (end > start && /\s/.test(text.charAt(end - 1))) end -= 1;
  if (end <= start) return null;
  end = Math.min(end, start + ANCHOR_QUOTE_MAX);
  while (end > start && /\s/.test(text.charAt(end - 1))) end -= 1;
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - ANCHOR_CONTEXT), start),
    suffix: text.slice(end, end + ANCHOR_CONTEXT),
  };
};

/** The passage a DOM range covers inside an editor's view, or null outside it. */
export const passageOfRange = (
  view: EditorView,
  range: Range
): CommentAnchor | null => {
  if (!view.dom.contains(range.commonAncestorContainer)) return null;
  try {
    const from = view.posAtDOM(range.startContainer, range.startOffset);
    const to = view.posAtDOM(range.endContainer, range.endOffset);
    return capturePassage(
      view.state.doc,
      Math.min(from, to),
      Math.max(from, to)
    );
  } catch {
    return null;
  }
};

/** What the plugin holds: the threads, the active one, and what it drew. */
interface AnchorState {
  threads: AnchoredThread[];
  activeId: string | null;
  located: string[];
  decorations: DecorationSet;
}

/** The plugin's key, which the editor's hook sends threads through. */
export const commentAnchorsKey = new PluginKey<AnchorState>('commentAnchors');

/** The class a highlighted passage carries, and the stronger one when active. */
export const ANCHOR_CLASS = 'comment-anchor';
const ACTIVE_CLASS = 'comment-anchor-active';

/** Finds every thread's passage and draws it, noting which were found. */
const draw = (
  doc: ProseMirrorNode,
  threads: AnchoredThread[],
  activeId: string | null
): Pick<AnchorState, 'located' | 'decorations'> => {
  if (threads.length === 0) {
    return { located: [], decorations: DecorationSet.empty };
  }
  const { text, positions } = flatten(doc);
  const located: string[] = [];
  const decorations: Decoration[] = [];
  for (const thread of threads) {
    const found = locatePassage(text, thread.anchor);
    if (found === null) continue;
    const from = positions[found.start] ?? -1;
    const last = positions[found.end - 1] ?? -1;
    if (from < 0 || last < 0) continue;
    located.push(thread.commentId);
    decorations.push(
      Decoration.inline(from, last + 1, {
        class:
          thread.commentId === activeId
            ? `${ANCHOR_CLASS} ${ACTIVE_CLASS}`
            : ANCHOR_CLASS,
        'data-comment-anchor': thread.commentId,
      })
    );
  }
  return { located, decorations: DecorationSet.create(doc, decorations) };
};

/** The threads and active one a transaction hands the plugin. */
type AnchorMeta = Pick<AnchorState, 'threads' | 'activeId'>;

/** Builds the decoration plugin, telling `onLocated` what it found. */
export const commentAnchorsPlugin = (
  onLocated: (commentIds: string[]) => void
): Plugin<AnchorState> =>
  new Plugin<AnchorState>({
    key: commentAnchorsKey,
    state: {
      init: () => ({
        threads: [],
        activeId: null,
        located: [],
        decorations: DecorationSet.empty,
      }),
      apply: (tr, previous) => {
        const meta = tr.getMeta(commentAnchorsKey) as AnchorMeta | undefined;
        if (meta === undefined && !tr.docChanged) return previous;
        const next = meta ?? previous;
        return {
          threads: next.threads,
          activeId: next.activeId,
          ...draw(tr.doc, next.threads, next.activeId),
        };
      },
    },
    props: {
      decorations: (state) => commentAnchorsKey.getState(state)?.decorations,
    },
    view: () => {
      let reported = '';
      const report = (state: EditorState): void => {
        const located = commentAnchorsKey.getState(state)?.located ?? [];
        const key = located.join(' ');
        if (key === reported) return;
        reported = key;
        onLocated(located);
      };
      return {
        update: (view) => {
          report(view.state);
        },
      };
    },
  });

/**
 * Draws a description's anchored threads in an editor. With no binding the
 * editor carries no plugin at all, so a comment box pays nothing for it.
 */
export const useCommentAnchors = (
  editor: Editor,
  binding: CommentAnchorsBinding | undefined
): void => {
  const enabled = binding !== undefined;
  const located = useRef(binding?.onLocated);
  located.current = binding?.onLocated;

  useEffect(() => {
    if (!enabled || editor.isDestroyed) return;
    editor.registerPlugin(
      commentAnchorsPlugin((ids) => {
        located.current?.(ids);
      })
    );
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(commentAnchorsKey);
    };
  }, [editor, enabled]);

  const threads = binding?.threads;
  const activeId = binding?.activeId ?? null;
  useEffect(() => {
    if (threads === undefined || editor.isDestroyed) return;
    const meta: AnchorMeta = { threads, activeId };
    editor.view.dispatch(
      editor.state.tr
        .setMeta(commentAnchorsKey, meta)
        .setMeta('addToHistory', false)
    );
  }, [editor, threads, activeId, enabled]);
};
