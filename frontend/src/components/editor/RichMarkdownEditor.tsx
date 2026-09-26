/**
 * A Markdown document edited as the rendered text itself, Linear style. There
 * is no edit mode: the surface is always the formatted document, and clicking
 * into it puts a caret there. Markdown shortcuts format as you type, and the
 * value going in and coming out is plain Markdown, so storage never changes.
 *
 * It knows nothing about issues. The caller supplies the Markdown, a commit
 * that persists it, and optionally a handler for pasted or dropped files, so
 * the same surface can back the comment composer later.
 *
 * Changes commit when focus leaves the surface or on Ctrl or Cmd Enter, and
 * Escape puts back the last committed text. Committing on each pause would
 * record a history row per pause, since every write of a body is an activity
 * entry, so the commit waits for the person to be done.
 *
 * This module is loaded lazily, so the page that shows a description does not
 * pay for the editor before its first paint.
 */

import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useKeyboardFocus } from '../../hooks/useKeyboardFocus';
import { filesFrom, normalizeLinkUrl } from '../../lib/attachments';
import { cn } from '../../lib/cn';
import { isSafeUrl } from '../../lib/markdown';
import { markdownExtensions } from './markdownExtensions';
import { readMarkdown, writeMarkdown } from './markdownCodec';
import './richMarkdown.css';

/** What a parent can do to the editor from outside. */
export interface RichMarkdownHandle {
  /** Puts the caret in the document, at the end. */
  focus: () => void;
  /** The document as Markdown right now, committed or not. */
  getMarkdown: () => string;
}

/** Props for RichMarkdownEditor. */
export interface RichMarkdownEditorProps {
  /** The committed Markdown. Adopted whenever the person is not mid edit. */
  value: string;
  /** False renders the same surface read only. */
  editable: boolean;
  /** Names the surface for assistive technology. */
  ariaLabel: string;
  /** Shown in an empty document the person may edit. */
  placeholder?: string;
  /** Puts the caret at the end as soon as the editor exists. */
  autoFocus?: boolean;
  /** Classes for the text itself, such as its size and line height. */
  className?: string;
  /**
   * Persists a changed document. Answering false, or rejecting, keeps the
   * change pending so the next commit tries again.
   */
  onCommit: (markdown: string) => Promise<boolean> | boolean | undefined;
  /** Receives files pasted or dropped on the surface. Unset leaves them be. */
  onFiles?: (files: File[]) => void;
  /** Told when focus enters or leaves the surface. */
  onFocusChange?: (focused: boolean) => void;
  /** Receives the imperative handle. */
  ref?: React.Ref<RichMarkdownHandle>;
}

/** Where the link field is open, relative to the surface. */
interface LinkDraft {
  href: string;
  top: number;
  left: number;
  invalid: boolean;
}

/** The link under the caret, or the empty string. */
const currentHref = (editor: Editor): string => {
  const attrs = editor.getAttributes('link') as { href?: unknown };
  return typeof attrs.href === 'string' ? attrs.href : '';
};

/** The rich Markdown surface. */
export const RichMarkdownEditor: React.FC<RichMarkdownEditorProps> = ({
  value,
  editable,
  ariaLabel,
  placeholder,
  autoFocus = false,
  className,
  onCommit,
  onFiles,
  onFocusChange,
  ref,
}) => {
  const surface = useRef<HTMLDivElement>(null);
  const baseline = useRef<string | null>(null);
  const latest = useRef<string | null>(null);
  const committed = useRef(value);
  const hadFocus = useRef(false);
  const handlers = useRef({ onCommit, onFiles, onFocusChange });
  handlers.current = { onCommit, onFiles, onFocusChange };

  const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null);
  const { keyboardFocused, focusProps } = useKeyboardFocus();

  const extensions = useMemo(
    () =>
      markdownExtensions(
        placeholder === undefined ? {} : { placeholder: placeholder }
      ),
    [placeholder]
  );

  const commitRef = useRef<() => void>(() => undefined);
  const revertRef = useRef<() => void>(() => undefined);
  const openLinkRef = useRef<() => void>(() => undefined);

  const editor = useEditor(
    {
      extensions,
      content: value,
      contentType: 'markdown',
      editable,
      autofocus: autoFocus ? 'end' : false,
      immediatelyRender: true,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: {
          class: 'rich-markdown',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': ariaLabel,
        },
        handleKeyDown: (_view, event) => {
          const mod = event.metaKey || event.ctrlKey;
          if (mod && event.key === 'Enter') {
            event.preventDefault();
            commitRef.current();
            (event.target as HTMLElement).blur();
            return true;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            revertRef.current();
            (event.target as HTMLElement).blur();
            return true;
          }
          if (mod && !event.shiftKey && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            openLinkRef.current();
            return true;
          }
          return false;
        },
        handlePaste: (_view, event) => {
          const accept = handlers.current.onFiles;
          const files = filesFrom(event.clipboardData);
          if (accept === undefined || files.length === 0) return false;
          event.preventDefault();
          accept(files);
          return true;
        },
        handleDrop: (_view, event, _slice, moved) => {
          const accept = handlers.current.onFiles;
          if (moved || accept === undefined) return false;
          const files = filesFrom(event.dataTransfer);
          if (files.length === 0) return false;
          event.preventDefault();
          event.stopPropagation();
          accept(files);
          return true;
        },
      },
      onCreate: ({ editor: created }) => {
        const markdown = readMarkdown(created);
        baseline.current = markdown;
        latest.current = markdown;
      },
      onUpdate: ({ editor: changed }) => {
        latest.current = readMarkdown(changed);
        if (!changed.isFocused) commitRef.current();
      },
      onFocus: () => {
        handlers.current.onFocusChange?.(true);
      },
      onBlur: ({ event }) => {
        const next = event.relatedTarget as Node | null;
        if (next !== null && surface.current?.contains(next) === true) return;
        handlers.current.onFocusChange?.(false);
        commitRef.current();
      },
    },
    [extensions]
  );

  const isDirty = useCallback(
    (): boolean =>
      latest.current !== null &&
      baseline.current !== null &&
      latest.current !== baseline.current,
    []
  );

  const commit = useCallback((): void => {
    if (!isDirty()) return;
    const markdown = latest.current ?? '';
    const previous = baseline.current;
    baseline.current = markdown;
    const restore = (): void => {
      if (baseline.current === markdown) baseline.current = previous;
    };
    Promise.resolve(handlers.current.onCommit(markdown))
      .then((saved) => {
        if (saved === false) restore();
        else committed.current = markdown;
      })
      .catch(restore);
  }, [isDirty]);
  commitRef.current = commit;

  const adopt = useCallback((next: Editor, markdown: string): void => {
    writeMarkdown(next, markdown);
    const read = readMarkdown(next);
    baseline.current = read;
    latest.current = read;
  }, []);

  revertRef.current = (): void => {
    if (!isDirty()) return;
    adopt(editor, committed.current);
  };

  openLinkRef.current = (): void => {
    const box = surface.current?.getBoundingClientRect();
    if (box === undefined) return;
    const caret = editor.view.coordsAtPos(editor.state.selection.from);
    setLinkDraft({
      href: currentHref(editor),
      top: caret.bottom - box.top + 4,
      left: Math.max(0, Math.min(caret.left - box.left, box.width - 288)),
      invalid: false,
    });
  };

  useEffect(() => {
    if (editor.isEditable !== editable) editor.setEditable(editable, false);
  }, [editor, editable]);

  useEffect(() => {
    if (editor.isFocused || isDirty()) return;
    committed.current = value;
    if (readMarkdown(editor) !== value) adopt(editor, value);
  }, [editor, value, isDirty, adopt]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent): void => {
      if (isDirty()) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
      commitRef.current();
    };
  }, [isDirty]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        editor.commands.focus('end');
      },
      getMarkdown: () => readMarkdown(editor),
    }),
    [editor]
  );

  const applyLink = (): void => {
    if (linkDraft === null) return;
    const typed = linkDraft.href.trim();
    const chain = editor.chain().focus().extendMarkRange('link');
    if (typed === '') {
      chain.unsetLink().run();
      setLinkDraft(null);
      return;
    }
    const href = normalizeLinkUrl(typed);
    if (href === null) {
      setLinkDraft({ ...linkDraft, invalid: true });
      return;
    }
    if (editor.state.selection.empty && currentHref(editor) === '') {
      chain
        .insertContent({
          type: 'text',
          text: typed,
          marks: [{ type: 'link', attrs: { href } }],
        })
        .run();
    } else {
      chain.setLink({ href }).run();
    }
    setLinkDraft(null);
  };

  const followLink = (event: React.MouseEvent): void => {
    const anchor = (event.target as HTMLElement).closest('a[href]');
    if (anchor === null) return;
    const href = anchor.getAttribute('href') ?? '';
    if (!isSafeUrl(href)) {
      event.preventDefault();
      return;
    }
    if (!editable) return;
    event.preventDefault();
    if (event.metaKey || event.ctrlKey || !hadFocus.current) {
      globalThis.open(href, '_blank', 'noopener,noreferrer');
      if (!hadFocus.current) editor.commands.blur();
    }
  };

  return (
    <div
      ref={surface}
      className={cn(
        'relative rounded-xs',
        editable && 'cursor-text',
        keyboardFocused && 'outline-2 outline-offset-4 outline-focus',
        className
      )}
      {...focusProps}
      onMouseDownCapture={() => {
        hadFocus.current = editor.isFocused;
      }}
      onClick={followLink}
    >
      <EditorContent editor={editor} />
      {linkDraft !== null && (
        <div
          className="absolute z-20 w-72 rounded-md border border-line bg-overlay p-1 shadow-overlay"
          style={{ top: linkDraft.top, left: linkDraft.left }}
        >
          <input
            autoFocus
            type="url"
            aria-label="Link address"
            aria-invalid={linkDraft.invalid}
            placeholder="Paste or type a link"
            value={linkDraft.href}
            className={cn(
              'h-7 w-full rounded-sm bg-transparent px-2 text-sm text-text outline-none placeholder:text-text-faint',
              linkDraft.invalid && 'text-danger'
            )}
            onChange={(event) => {
              setLinkDraft({
                ...linkDraft,
                href: event.target.value,
                invalid: false,
              });
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                applyLink();
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setLinkDraft(null);
                editor.commands.focus();
              }
            }}
            onBlur={(event) => {
              const next = event.relatedTarget as Node | null;
              if (next !== null && surface.current?.contains(next) === true) {
                return;
              }
              setLinkDraft(null);
              handlers.current.onFocusChange?.(false);
              commit();
            }}
          />
        </div>
      )}
    </div>
  );
};

export default RichMarkdownEditor;
