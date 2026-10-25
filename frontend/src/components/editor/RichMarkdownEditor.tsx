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
 * Inside a workspace, typing `#` or a team's key opens a picker of the issues,
 * projects and documents the writer can see, and issue keys and links to
 * projects and documents are drawn as chips while editing.
 *
 * Selecting text floats a compact formatting toolbar over it, and typing `/`
 * at the start of a line or after a space opens an insert menu of blocks, both
 * writing only what the Markdown shortcuts already write.
 *
 * Changes commit when focus leaves the surface or on Ctrl or Cmd Enter, and
 * Escape puts back the last committed text. Text input made only of control
 * characters is dropped, so a stray carriage return trailing Ctrl or Cmd
 * Enter never lands in the document. Committing on each pause would
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
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { TeamsContext } from '../../contexts/TeamsContextDefinition';
import { WorkspaceContext } from '../../contexts/WorkspaceContextDefinition';
import { useKeyboardFocus } from '../../hooks/useKeyboardFocus';
import { useReferenceResults } from '../../hooks/useReferenceResults';
import { filesFrom, normalizeLinkUrl } from '../../lib/attachments';
import { cn } from '../../lib/cn';
import {
  personAvatar,
  personLabel,
  type Assignable,
} from '../../lib/issuePeople';
import { isTeamKey } from '../../lib/issueDisplay';
import { isSafeUrl } from '../../lib/markdown';
import { UPLOAD_CONTENT_TYPES } from '../../lib/uploads';
import { isContentPath, resolveMediaUrl } from '../../lib/media';
import { useMedia } from '../../lib/mediaContext';
import { matchPeople, mentionHandle, mentionQuery } from '../../lib/mentions';
import {
  currentOrigin,
  isSearchable,
  linkedReference,
  referenceHref,
  referenceQuery,
  type ReferenceItem,
} from '../../lib/references';
import Avatar from '../ui/avatar';
import type { MarkdownDensity } from '../ui/markdown';
import { DocumentLinkMenu } from './DocumentLinkMenu';
import { formattingToolbarKey, type FormatContext } from './formatting';
import { FormattingToolbar } from './FormattingToolbar';
import { markdownExtensions, referenceChipsKey } from './markdownExtensions';
import { readMarkdown, writeMarkdown } from './markdownCodec';
import {
  hasUploadsInFlight,
  insertUploads,
  type UploadFile,
} from './mediaNodes';
import { ReferenceMenu } from './ReferenceMenu';
import {
  filterSlashCommands,
  slashQuery,
  type SlashCommand,
  type SlashContext,
} from './slashCommands';
import { SlashMenu } from './SlashMenu';
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
  /**
   * Adds a Markdown passage, such as a quote, after what is written, then an
   * empty paragraph with the caret in it, as an edit still to be committed.
   */
  appendMarkdown: (markdown: string) => void;
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
   * How tightly the document sets, matching the static body it edits.
   * Defaults to comfortable.
   */
  density?: MarkdownDensity;
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

/** The `#` reference being typed, where it sits, and where its list opens. */
type ReferenceDraft = MentionDraft;

/** The `/` insert query being typed, where it sits, and where its menu opens. */
type SlashDraft = MentionDraft;

/** Where a suggestion list opens and the text it would replace. */
interface CaretQuery {
  start: number;
  query: string;
}

/**
 * Whether typed text is only control characters, such as the carriage return
 * a synthetic Ctrl or Cmd Enter can deliver after its keydown was handled.
 * Such text is never meant as content, so the surface swallows it.
 */
const isControlText = (text: string): boolean =>
  text !== '' &&
  [...text].every((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });

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
  density = 'comfortable',
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

  const workspace = useContext(WorkspaceContext)?.workspace ?? null;
  const teams = useContext(TeamsContext)?.data ?? null;
  const [reference, setReference] = useState<ReferenceDraft | null>(null);
  const [referenceHighlight, setReferenceHighlight] = useState(0);
  const referenceResults = useReferenceResults(
    workspace?.id ?? null,
    reference?.query ?? null
  );
  const shownReferenceHighlight = Math.min(
    referenceHighlight,
    Math.max(0, referenceResults.items.length - 1)
  );
  const referenceState = useRef({
    reference,
    items: referenceResults.items,
    highlight: shownReferenceHighlight,
  });
  referenceState.current = {
    reference,
    items: referenceResults.items,
    highlight: shownReferenceHighlight,
  };
  const chooseReferenceRef = useRef<(item: ReferenceItem) => void>(
    () => undefined
  );
  const lookup = useRef({ workspace, teams });
  lookup.current = { workspace, teams };
  const { keyboardFocused, focusProps } = useKeyboardFocus();

  const filePicker = useRef<HTMLInputElement>(null);
  const [slash, setSlash] = useState<SlashDraft | null>(null);
  const [slashHighlight, setSlashHighlight] = useState(0);
  const slashDismissed = useRef<number | null>(null);
  const canMention = mentionPeople !== undefined;
  const canUpload = uploadFile !== undefined;
  const slashContext = useMemo<SlashContext>(
    () => ({
      mentions: canMention,
      ...(canUpload
        ? {
            pickFiles: () => {
              filePicker.current?.click();
            },
          }
        : {}),
    }),
    [canMention, canUpload]
  );
  const slashMatches = useMemo(
    () =>
      slash === null ? [] : filterSlashCommands(slash.query, slashContext),
    [slash, slashContext]
  );
  const shownSlashHighlight = Math.min(
    slashHighlight,
    Math.max(0, slashMatches.length - 1)
  );
  const slashState = useRef({
    slash,
    matches: slashMatches,
    highlight: shownSlashHighlight,
  });
  slashState.current = {
    slash,
    matches: slashMatches,
    highlight: shownSlashHighlight,
  };
  const chooseSlashRef = useRef<(command: SlashCommand) => void>(
    () => undefined
  );

  const extensions = useMemo(
    () =>
      markdownExtensions({
        ...(placeholder === undefined ? {} : { placeholder: placeholder }),
        isIssueKey: (key) => {
          const known = lookup.current.teams;
          return known !== null && isTeamKey(key, known);
        },
        isReferenceLink: (href) => {
          const slug = lookup.current.workspace?.slug;
          const target = linkedReference(href, currentOrigin());
          return slug !== undefined && target?.slug === slug;
        },
      }),
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
          const inserting = slashState.current;
          if (inserting.slash !== null && inserting.matches.length > 0) {
            const count = inserting.matches.length;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setSlashHighlight((inserting.highlight + step + count) % count);
              return true;
            }
            if ((event.key === 'Enter' && !mod) || event.key === 'Tab') {
              const command = inserting.matches[inserting.highlight];
              if (command !== undefined) {
                event.preventDefault();
                chooseSlashRef.current(command);
                return true;
              }
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              slashDismissed.current = inserting.slash.from;
              setSlash(null);
              return true;
            }
          }
          const picking = referenceState.current;
          if (picking.reference !== null) {
            const count = picking.items.length;
            if (
              count > 0 &&
              (event.key === 'ArrowDown' || event.key === 'ArrowUp')
            ) {
              event.preventDefault();
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setReferenceHighlight((picking.highlight + step + count) % count);
              return true;
            }
            if ((event.key === 'Enter' && !mod) || event.key === 'Tab') {
              const item = picking.items[picking.highlight];
              if (item !== undefined) {
                event.preventDefault();
                chooseReferenceRef.current(item);
                return true;
              }
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setReference(null);
              return true;
            }
          }
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
        handleTextInput: (_view, _from, _to, text) => isControlText(text),
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
        setReference(null);
        setSlash(null);
        handlers.current.onFocusChange?.(false);
        commitRef.current();
      },
    },
    [extensions]
  );
  const editorRef = useRef(editor);
  editorRef.current = editor;

  readMentionRef.current = (current: Editor): void => {
    const { selection } = current.state;
    const box = surface.current?.getBoundingClientRect();
    const { $from } = selection;
    if (
      !current.isEditable ||
      !selection.empty ||
      box === undefined ||
      $from.parent.type.spec.code === true ||
      current.isActive('code')
    ) {
      setMention(null);
      setReference(null);
      setSlash(null);
      return;
    }
    const before = $from.parent.textBetween(
      0,
      $from.parentOffset,
      undefined,
      '\ufffc'
    );
    const place = (typed: CaretQuery, width: number): MentionDraft => {
      const from = $from.pos - (before.length - typed.start);
      const caret = current.view.coordsAtPos(from);
      return {
        query: typed.query,
        from,
        to: $from.pos,
        top: caret.bottom - box.top + 4,
        left: Math.max(0, Math.min(caret.left - box.left, box.width - width)),
      };
    };
    const typedReference =
      lookup.current.workspace === null
        ? null
        : referenceQuery(before, before.length, lookup.current.teams ?? []);
    if (typedReference !== null) {
      setMention(null);
      setSlash(null);
      if (referenceState.current.reference?.query !== typedReference.query) {
        setReferenceHighlight(0);
      }
      setReference(place(typedReference, 320));
      return;
    }
    setReference(null);
    const typedSlash = slashQuery(before);
    if (typedSlash === null) {
      slashDismissed.current = null;
    } else {
      const opened = place(typedSlash, 256);
      if (slashDismissed.current !== opened.from) {
        setMention(null);
        if (slashState.current.slash?.query !== typedSlash.query) {
          setSlashHighlight(0);
        }
        setSlash(opened);
        return;
      }
    }
    setSlash(null);
    if (mentionPeople === undefined) return;
    const typed = mentionQuery(before, before.length);
    if (typed === null) {
      setMention(null);
      return;
    }
    if (mentionState.current.mention?.query !== typed.query) setHighlight(0);
    setMention(place(typed, 256));
  };

  chooseReferenceRef.current = (item: ReferenceItem): void => {
    const open = referenceState.current.reference;
    const slug = lookup.current.workspace?.slug;
    if (open === null || slug === undefined) return;
    const range = { from: open.from, to: open.to };
    const chain = editor.chain().focus();
    if (item.kind === 'issue') {
      chain.insertContentAt(range, `${item.key} `).run();
    } else {
      chain
        .insertContentAt(range, [
          {
            type: 'text',
            text: item.kind === 'project' ? item.name : item.title,
            marks: [
              {
                type: 'link',
                attrs: { href: referenceHref(currentOrigin(), slug, item) },
              },
            ],
          },
          { type: 'text', text: ' ' },
        ])
        .run();
    }
    setReference(null);
  };

  chooseSlashRef.current = (command: SlashCommand): void => {
    const open = slashState.current.slash;
    if (open === null) return;
    setSlash(null);
    command.run(editor, { from: open.from, to: open.to }, slashContext);
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
    editor.view.dispatch(editor.state.tr.setMeta(formattingToolbarKey, 'hide'));
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

  const chipsDrawnFor = useRef({ teams, workspace });
  useEffect(() => {
    const drawn = chipsDrawnFor.current;
    if (drawn.teams === teams && drawn.workspace === workspace) return;
    chipsDrawnFor.current = { teams, workspace };
    if (editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(referenceChipsKey, true));
  }, [editor, teams, workspace]);

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
        setReference(null);
        setSlash(null);
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
      appendMarkdown: (markdown: string) => {
        const current = readMarkdown(editor);
        baseline.current ??= current;
        writeMarkdown(
          editor,
          current.trim() === '' ? markdown : `${current}\n\n${markdown}`
        );
        editor
          .chain()
          .focus()
          .insertContentAt(editor.state.doc.content.size, { type: 'paragraph' })
          .focus('end')
          .run();
        latest.current = readMarkdown(editor);
      },
    }),
    [editor, adopt]
  );

  const formatContext = useMemo<FormatContext>(
    () => ({
      openLink: () => {
        openLinkRef.current();
      },
    }),
    []
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
        density === 'compact' && 'rich-markdown-compact',
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
      {editable && (
        <FormattingToolbar editor={editor} context={formatContext} />
      )}
      {slash !== null && slashMatches.length > 0 && (
        <SlashMenu
          commands={slashMatches}
          highlight={shownSlashHighlight}
          top={slash.top}
          left={slash.left}
          onChoose={(command) => {
            chooseSlashRef.current(command);
          }}
          onHighlight={setSlashHighlight}
        />
      )}
      {editable && canUpload && (
        <input
          ref={filePicker}
          type="file"
          multiple
          hidden
          accept={UPLOAD_CONTENT_TYPES.join(',')}
          aria-label="Upload an image or attachment"
          onChange={(event) => {
            const upload = handlers.current.uploadFile;
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            if (upload === undefined || files.length === 0) return;
            insertUploads(editor, files, upload);
          }}
        />
      )}
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
                'flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm hover:bg-raised hover:text-text active:bg-line',
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
              <Avatar
                name={personLabel(person)}
                src={personAvatar(person)}
                size="sm"
              />
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
      {reference !== null && (
        <ReferenceMenu
          items={referenceResults.items}
          highlight={shownReferenceHighlight}
          loading={referenceResults.loading}
          searchable={isSearchable(reference.query)}
          top={reference.top}
          left={reference.left}
          onChoose={(item) => {
            chooseReferenceRef.current(item);
          }}
          onHighlight={setReferenceHighlight}
        />
      )}
      {editable && <DocumentLinkMenu editor={editor} />}
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
