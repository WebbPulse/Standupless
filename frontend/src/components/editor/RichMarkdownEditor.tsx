/**
 * A Markdown document edited as the rendered text itself, Linear style. There
 * is no edit mode: the surface is always the formatted document, and clicking
 * into it puts a caret there. Markdown shortcuts format as you type, and the
 * value going in and coming out is plain Markdown, so storage never changes.
 *
 * It knows nothing about issues. The caller supplies the Markdown, a commit
 * that persists it, and optionally an uploader: with one, a pasted, dropped or
 * picked image or video lands inline behind a progress bar and any other file
 * lands as a link to it. The same surface backs the comment composer, which
 * adds a submit, a cancel and @mention suggestions from the people it names.
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
import { personLabel, type Assignable } from '../../lib/issuePeople';
import { isSafeUrl } from '../../lib/markdown';
import { isContentPath, resolveMediaUrl } from '../../lib/media';
import { useMedia } from '../../lib/mediaContext';
import { matchPeople, mentionHandle, mentionQuery } from '../../lib/mentions';
import Avatar from '../ui/avatar';
import { markdownExtensions } from './markdownExtensions';
import { readMarkdown, writeMarkdown } from './markdownCodec';
import {
  hasUploadsInFlight,
  insertUploads,
  type UploadFile,
} from './mediaNodes';
import './richMarkdown.css';

/** What a parent can do to the editor from outside. */
export interface RichMarkdownHandle {
  /** Puts the caret in the document, at the end. */
  focus: () => void;
  /** The document as Markdown right now, committed or not. */
  getMarkdown: () => string;
  /** Replaces the document and takes it as committed, as after a post. */
  setMarkdown: (markdown: string) => void;
  /** Uploads files in at the caret, when the surface has an uploader. */
  insertFiles: (files: File[]) => void;
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
  /**
   * Receives files pasted or dropped on the surface when there is no
   * uploader. Unset leaves them be.
   */
  onFiles?: (files: File[]) => void;
  /** Uploads a file placed in the document, which then embeds or links it. */
  uploadFile?: UploadFile;
  /** Told the Markdown after every change, and whether a file is in flight. */
  onChange?: (markdown: string, uploading: boolean) => void;
  /** Ctrl or Cmd Enter calls this instead of committing, as a composer posts. */
  onSubmit?: () => void;
  /** Escape calls this instead of putting the committed text back. */
  onCancel?: () => void;
  /** The people an @mention may suggest. Unset offers no suggestions. */
  mentionPeople?: Assignable[];
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

/** The @mention being typed, where it sits, and where its list opens. */
interface MentionDraft {
  query: string;
  from: number;
  to: number;
  top: number;
  left: number;
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
  uploadFile,
  onChange,
  onSubmit,
  onCancel,
  mentionPeople,
  onFocusChange,
  ref,
}) => {
  const surface = useRef<HTMLDivElement>(null);
  const baseline = useRef<string | null>(null);
  const latest = useRef<string | null>(null);
  const committed = useRef(value);
  const hadFocus = useRef(false);
  const { tokens } = useMedia();
  const handlers = useRef({
    onCommit,
    onFiles,
    onFocusChange,
    uploadFile,
    onChange,
    onSubmit,
    onCancel,
    tokens,
  });
  handlers.current = {
    onCommit,
    onFiles,
    onFocusChange,
    uploadFile,
    onChange,
    onSubmit,
    onCancel,
    tokens,
  };

  const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null);
  const [mention, setMention] = useState<MentionDraft | null>(null);
  const [highlight, setHighlight] = useState(0);
  const matches = useMemo(
    () =>
      mention === null || mentionPeople === undefined
        ? []
        : matchPeople(mentionPeople, mention.query),
    [mention, mentionPeople]
  );
  const mentionState = useRef({ mention, matches, highlight });
  mentionState.current = { mention, matches, highlight };
  const readMentionRef = useRef<(editor: Editor) => void>(() => undefined);
  const chooseRef = useRef<(person: Assignable) => void>(() => undefined);
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
          const open = mentionState.current;
          if (open.mention !== null && open.matches.length > 0) {
            const count = open.matches.length;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setHighlight((open.highlight + step + count) % count);
              return true;
            }
            if ((event.key === 'Enter' && !mod) || event.key === 'Tab') {
              const person = open.matches[open.highlight];
              if (person !== undefined) {
                event.preventDefault();
                chooseRef.current(person);
                return true;
              }
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setMention(null);
              return true;
            }
          }
          if (mod && event.key === 'Enter') {
            event.preventDefault();
            const submit = handlers.current.onSubmit;
            if (submit !== undefined) {
              submit();
              return true;
            }
            commitRef.current();
            (event.target as HTMLElement).blur();
            return true;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            const cancel = handlers.current.onCancel;
            if (cancel !== undefined) {
              cancel();
              return true;
            }
            if (handlers.current.onSubmit === undefined) revertRef.current();
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
        handlePaste: (view, event) => {
          const files = filesFrom(event.clipboardData);
          if (files.length === 0) return false;
          const upload = handlers.current.uploadFile;
          const accept = handlers.current.onFiles;
          if (upload !== undefined && view.editable) {
            event.preventDefault();
            insertUploads(editorRef.current, files, upload);
            return true;
          }
          if (accept === undefined) return false;
          event.preventDefault();
          accept(files);
          return true;
        },
        handleDrop: (view, event, _slice, moved) => {
          if (moved) return false;
          const files = filesFrom(event.dataTransfer);
          if (files.length === 0) return false;
          const upload = handlers.current.uploadFile;
          const accept = handlers.current.onFiles;
          if (upload !== undefined && view.editable) {
            event.preventDefault();
            event.stopPropagation();
            const dropped = view.posAtCoords({
              left: event.clientX,
              top: event.clientY,
            });
            insertUploads(editorRef.current, files, upload, dropped?.pos);
            return true;
          }
          if (accept === undefined) return false;
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
        handlers.current.onChange?.(
          latest.current,
          hasUploadsInFlight(changed)
        );
        readMentionRef.current(changed);
        if (!changed.isFocused) commitRef.current();
      },
      onSelectionUpdate: ({ editor: moved }) => {
        readMentionRef.current(moved);
      },
      onFocus: () => {
        handlers.current.onFocusChange?.(true);
      },
      onBlur: ({ event }) => {
        const next = event.relatedTarget as Node | null;
        if (next !== null && surface.current?.contains(next) === true) return;
        setMention(null);
        handlers.current.onFocusChange?.(false);
        commitRef.current();
      },
    },
    [extensions]
  );
  const editorRef = useRef(editor);
  editorRef.current = editor;

  readMentionRef.current = (current: Editor): void => {
    if (mentionPeople === undefined) return;
    const { selection } = current.state;
    const box = surface.current?.getBoundingClientRect();
    const { $from } = selection;
    if (
      !selection.empty ||
      box === undefined ||
      $from.parent.type.spec.code === true
    ) {
      setMention(null);
      return;
    }
    const before = $from.parent.textBetween(
      0,
      $from.parentOffset,
      undefined,
      '\ufffc'
    );
    const typed = mentionQuery(before, before.length);
    if (typed === null) {
      setMention(null);
      return;
    }
    const from = $from.pos - (before.length - typed.start);
    const caret = current.view.coordsAtPos(from);
    if (mentionState.current.mention?.query !== typed.query) setHighlight(0);
    setMention({
      query: typed.query,
      from,
      to: $from.pos,
      top: caret.bottom - box.top + 4,
      left: Math.max(0, Math.min(caret.left - box.left, box.width - 256)),
    });
  };

  chooseRef.current = (person: Assignable): void => {
    const open = mentionState.current.mention;
    if (open === null) return;
    editor
      .chain()
      .focus()
      .insertContentAt(
        { from: open.from, to: open.to },
        `@${mentionHandle(person)} `
      )
      .run();
    setMention(null);
  };

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
      setMarkdown: (markdown: string) => {
        committed.current = markdown;
        adopt(editor, markdown);
        setMention(null);
        handlers.current.onChange?.(
          readMarkdown(editor),
          hasUploadsInFlight(editor)
        );
      },
      insertFiles: (files: File[]) => {
        const upload = handlers.current.uploadFile;
        if (upload === undefined) return;
        insertUploads(editor, files, upload);
      },
    }),
    [editor, adopt]
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
    const stored = anchor.getAttribute('href') ?? '';
    const href = isContentPath(stored)
      ? (resolveMediaUrl(stored, handlers.current.tokens) ?? '')
      : stored;
    if (!isSafeUrl(href)) {
      event.preventDefault();
      return;
    }
    if (!editable) {
      if (href !== stored) {
        event.preventDefault();
        globalThis.open(href, '_blank', 'noopener,noreferrer');
      }
      return;
    }
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
      onMouseDown={(event) => {
        if (!editable || event.target !== event.currentTarget) return;
        event.preventDefault();
        editor.commands.focus('end');
      }}
      onClick={followLink}
    >
      <EditorContent editor={editor} />
      {mention !== null && matches.length > 0 && (
        <ul
          role="listbox"
          aria-label="Mention someone"
          className="absolute z-20 w-64 overflow-hidden rounded-md border border-line bg-overlay py-1 shadow-overlay"
          style={{ top: mention.top, left: mention.left }}
        >
          {matches.map((person, index) => (
            <li
              key={person.user_id}
              role="option"
              aria-selected={index === highlight}
              className={cn(
                'flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm',
                index === highlight ? 'bg-raised text-text' : 'text-text-muted'
              )}
              onMouseDown={(event) => {
                event.preventDefault();
                chooseRef.current(person);
              }}
              onMouseEnter={() => {
                setHighlight(index);
              }}
            >
              <Avatar name={personLabel(person)} size="sm" />
              <span className="min-w-0 flex-1 truncate text-text">
                {personLabel(person)}
              </span>
              <span className="shrink-0 text-xs text-text-faint">
                @{mentionHandle(person)}
              </span>
            </li>
          ))}
        </ul>
      )}
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
