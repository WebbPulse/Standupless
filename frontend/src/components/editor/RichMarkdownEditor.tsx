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
 * writing only what the Markdown shortcuts already write. A surface given a
 * selection issue source also offers filing an issue from the selection, which
 * opens the workspace's create dialog on the selected text and puts the new
 * issue's key in its place. One that names a parent issue also files
 * sub-issues of it, from the toolbar when the selection is a list and on
 * Ctrl or Cmd Shift O for any selection, which with nothing selected is left
 * to the page.
 *
 * A day goes in as a date chip, from the `/date` picker or from the Date group
 * the `@` menu shows when the text after the `@` reads as a date, and `|--`
 * on an empty line starts a table.
 *
 * On a full-size editable surface, hovering a block or a list item shows a
 * grip in the left gutter that drags the block to a new place and opens a
 * menu to turn it into another block type, duplicate it or delete it.
 * Alt+Shift+ArrowUp and Alt+Shift+ArrowDown move the block at the caret on
 * every editable surface.
 *
 * Changes commit when focus leaves the surface or on Ctrl or Cmd Enter, and
 * Escape puts back the last committed text, except right after a video link
 * was pasted as an embed, when it keeps the link instead. Text input made
 * only of control characters is dropped, so a stray carriage return trailing
 * Ctrl or Cmd Enter never lands in the document. Committing on each pause would
 * record a history row per pause, since every write of a body is an activity
 * entry, so the commit waits for the person to be done.
 *
 * This module is loaded lazily, so the page that shows a description does not
 * pay for the editor before its first paint.
 */

import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { LuCalendar } from 'react-icons/lu';
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
import { useCreateIssue } from '../../hooks/useCreateIssue';
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
import { answersToSlug } from '../../lib/workspaceSlug';
import type { CommentAnchor } from '../../types/Api';
import { isContentPath, resolveMediaUrl } from '../../lib/media';
import { useMedia } from '../../lib/mediaContext';
import {
  dateMentionOptions,
  dateMentionQuery,
  type DateMentionOption,
} from '../../lib/dateChips';
import { matchPeople, mentionHandle, mentionQuery } from '../../lib/mentions';
import { isAway, statusSummary } from '../../lib/userStatus';
import {
  currentOrigin,
  isSearchable,
  linkedPullRequest,
  linkedReference,
  referenceLabel,
  referenceLinkHref,
  referenceQuery,
  type ReferenceItem,
} from '../../lib/references';
import Avatar from '../ui/avatar';
import type { MarkdownDensity } from '../ui/markdown';
import {
  BLOCK_MENU_EVENT,
  canTurnInto,
  deleteBlock,
  duplicateBlock,
  turnBlockInto,
  type BlockMenuRequest,
} from './blockHandle';
import { BlockMenu, type TurnIntoOption } from './BlockMenu';
import { DateChipPicker } from './DateChipPicker';
import { DocumentLinkMenu } from './DocumentLinkMenu';
import { isAttachChord, toggleChecklistItem } from './editorShortcuts';
import { formattingToolbarKey, type FormatContext } from './formatting';
import { FormattingToolbar } from './FormattingToolbar';
import { markdownExtensions, referenceChipsKey } from './markdownExtensions';
import { keepPastedVideoAsLink } from './videoEmbed';
import { useDelegatedIssueHoverCard } from '../ui/IssueHoverCard';
import { readMarkdown, writeMarkdown } from './markdownCodec';
import {
  hasUploadsInFlight,
  insertUploads,
  type UploadFile,
} from './mediaNodes';
import { ReferenceMenu } from './ReferenceMenu';
import {
  createIssueFromSelection,
  createSubIssuesFromList,
  subIssuesFromSelection,
  type SelectionIssueSource,
} from './selectionIssue';
import {
  passageOfRange,
  useCommentAnchors,
  type CommentAnchorsBinding,
} from './commentAnchors';
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
  /** Puts the caret in the document, at the end unless told the start. */
  focus: (at?: 'start' | 'end') => void;
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
  /** The passage a selected DOM range covers, for pinning a comment to it. */
  passageAt: (range: Range) => CommentAnchor | null;
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
  /**
   * Backspace in an empty document, or ArrowUp at the very start of its first
   * text block, calls this to hand the caret to the field above.
   */
  onExitTop?: () => void;
  /** The comment threads pinned to passages of this document, highlighted. */
  commentAnchors?: CommentAnchorsBinding;
  /**
   * Where an issue filed from the selection lands and what it relates to.
   * Unset leaves the selection toolbar without the create issue button.
   */
  selectionIssue?: SelectionIssueSource;
  /**
   * Whether hovering a block shows the grip that drags it and opens its
   * menu. Defaults to on, except on a compact surface such as a comment.
   */
  blockHandles?: boolean;
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

/** One row of the @ menu: a person to mention or a day to insert as a chip. */
type MentionOption =
  | { kind: 'person'; person: Assignable }
  | { kind: 'date'; date: DateMentionOption };

/** Where the block menu opens and the position of the block it acts on. */
interface BlockMenuDraft {
  pos: number;
  top: number;
  left: number;
}

/** Where the `/date` picker opens and the position its chip goes in at. */
interface DatePickerDraft {
  at: number;
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

/** Whether the document is one empty text block, as a fresh one is. */
const isEmptyDocument = (state: EditorState): boolean => {
  const only = state.doc.firstChild;
  return (
    state.doc.childCount === 1 &&
    only !== null &&
    only.isTextblock &&
    only.content.size === 0
  );
};

/** Whether a collapsed caret sits at the very start of the first text block. */
const isAtDocumentStart = (state: EditorState): boolean => {
  const { selection } = state;
  if (!selection.empty) return false;
  const { $from } = selection;
  if (!$from.parent.isTextblock || $from.parentOffset !== 0) return false;
  let first = -1;
  state.doc.descendants((node, pos) => {
    if (first >= 0) return false;
    if (node.isTextblock) {
      first = pos;
      return false;
    }
    return true;
  });
  return $from.before() === first;
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
  onExitTop,
  commentAnchors,
  selectionIssue,
  blockHandles,
  ref,
}) => {
  const surface = useRef<HTMLDivElement>(null);
  const issueHoverCard = useDelegatedIssueHoverCard(surface, '.rich-issue-ref');
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
    onExitTop,
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
    onExitTop,
    tokens,
  };

  const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null);
  const [mention, setMention] = useState<MentionDraft | null>(null);
  const [highlight, setHighlight] = useState(0);
  const matches = useMemo<MentionOption[]>(() => {
    if (mention === null) return [];
    const people =
      mentionPeople === undefined
        ? []
        : matchPeople(mentionPeople, mention.query).map(
            (person): MentionOption => ({ kind: 'person', person })
          );
    const dates = dateMentionOptions(mention.query).map(
      (date): MentionOption => ({ kind: 'date', date })
    );
    return [...people, ...dates];
  }, [mention, mentionPeople]);
  const mentionState = useRef({ mention, matches, highlight });
  mentionState.current = { mention, matches, highlight };
  const readMentionRef = useRef<(editor: Editor) => void>(() => undefined);
  const chooseRef = useRef<(option: MentionOption) => void>(() => undefined);
  const [datePicker, setDatePicker] = useState<DatePickerDraft | null>(null);
  const [blockMenu, setBlockMenu] = useState<BlockMenuDraft | null>(null);
  const showBlockHandles = editable && (blockHandles ?? density !== 'compact');
  const openDatePickerRef = useRef<() => void>(() => undefined);

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
      pickDate: () => {
        openDatePickerRef.current();
      },
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
          const workspace = lookup.current.workspace;
          if (workspace === null) return false;
          if (linkedPullRequest(href) !== null) return true;
          const target = linkedReference(href, currentOrigin());
          return target !== null && answersToSlug(workspace, target.slug);
        },
      }),
    [placeholder]
  );

  const commitRef = useRef<() => void>(() => undefined);
  const subIssueRef = useRef<() => boolean>(() => false);
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
        handleKeyDown: (view, event) => {
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
              const option = open.matches[open.highlight];
              if (option !== undefined) {
                event.preventDefault();
                chooseRef.current(option);
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
          const exitTop = handlers.current.onExitTop;
          if (
            exitTop !== undefined &&
            view.editable &&
            !mod &&
            !event.shiftKey &&
            !event.altKey &&
            ((event.key === 'Backspace' && isEmptyDocument(view.state)) ||
              (event.key === 'ArrowUp' && isAtDocumentStart(view.state)))
          ) {
            event.preventDefault();
            exitTop();
            return true;
          }
          if (mod && event.key === 'Enter') {
            event.preventDefault();
            if (
              view.editable &&
              toggleChecklistItem(view.state, view.dispatch, event.shiftKey)
            ) {
              return true;
            }
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
            if (keepPastedVideoAsLink(editorRef.current)) return true;
            const cancel = handlers.current.onCancel;
            if (cancel !== undefined) {
              cancel();
              return true;
            }
            if (handlers.current.onSubmit === undefined) revertRef.current();
            (event.target as HTMLElement).blur();
            return true;
          }
          if (
            mod &&
            event.shiftKey &&
            !event.altKey &&
            event.key.toLowerCase() === 'o' &&
            view.editable &&
            !view.state.selection.empty &&
            subIssueRef.current()
          ) {
            event.preventDefault();
            event.stopPropagation();
            return true;
          }
          if (isAttachChord(event)) {
            const picker = filePicker.current;
            if (
              !view.editable ||
              handlers.current.uploadFile === undefined ||
              picker === null
            ) {
              return false;
            }
            event.preventDefault();
            event.stopPropagation();
            picker.click();
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
    const typed =
      (mentionPeople === undefined
        ? null
        : mentionQuery(before, before.length)) ?? dateMentionQuery(before);
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
            text: referenceLabel(item),
            marks: [
              {
                type: 'link',
                attrs: { href: referenceLinkHref(item, currentOrigin(), slug) },
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

  chooseRef.current = (option: MentionOption): void => {
    const open = mentionState.current.mention;
    if (open === null) return;
    const range = { from: open.from, to: open.to };
    const chain = editor.chain().focus();
    if (option.kind === 'date') {
      chain.insertDateChip(option.date.value, range).run();
    } else {
      chain.insertContentAt(range, `@${mentionHandle(option.person)} `).run();
    }
    setMention(null);
  };

  openDatePickerRef.current = (): void => {
    const box = surface.current?.getBoundingClientRect();
    if (box === undefined) return;
    const at = editor.state.selection.from;
    const caret = editor.view.coordsAtPos(at);
    setDatePicker({
      at,
      top: caret.bottom - box.top + 4,
      left: Math.max(0, Math.min(caret.left - box.left, box.width - 256)),
    });
  };

  const pickDate = (value: string): void => {
    const open = datePicker;
    setDatePicker(null);
    if (open === null) return;
    const at = Math.min(open.at, editor.state.doc.content.size);
    editor.chain().focus().insertDateChip(value, { from: at, to: at }).run();
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

  useEffect(() => {
    const dom = editor.view.dom;
    const open = (event: Event): void => {
      const { pos, anchor } = (event as CustomEvent<BlockMenuRequest>).detail;
      const box = surface.current?.getBoundingClientRect();
      if (box === undefined) return;
      setBlockMenu({
        pos,
        top: anchor.bottom - box.top + 4,
        left: Math.min(anchor.left - box.left, box.width - 176),
      });
    };
    dom.addEventListener(BLOCK_MENU_EVENT, open);
    return () => {
      dom.removeEventListener(BLOCK_MENU_EVENT, open);
    };
  }, [editor]);

  const closeBlockMenu = useCallback((): void => {
    setBlockMenu(null);
    editor.commands.focus();
  }, [editor]);

  const blockMenuNode =
    blockMenu === null ? null : editor.state.doc.nodeAt(blockMenu.pos);

  const turnInto = (option: TurnIntoOption): void => {
    const open = blockMenu;
    setBlockMenu(null);
    if (open === null) return;
    const { command } = option;
    turnBlockInto(
      editor,
      open.pos,
      command === null
        ? null
        : (target, range) => {
            command.run(target, range, slashContext);
          }
    );
  };

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

  useCommentAnchors(editor, commentAnchors);

  useImperativeHandle(
    ref,
    () => ({
      focus: (at = 'end') => {
        editor.commands.focus(at);
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
      passageAt: (range: Range) => passageOfRange(editor.view, range),
    }),
    [editor, adopt]
  );

  const issueCreator = useCreateIssue();
  const canCreateIssue = selectionIssue !== undefined && issueCreator.canCreate;
  const workspaceId = workspace?.id;
  const canCreateSubIssues =
    canCreateIssue &&
    selectionIssue?.parent !== undefined &&
    workspaceId !== undefined;
  const selectionIssueRef = useRef({
    selectionIssue,
    open: issueCreator.open,
    workspaceId,
  });
  selectionIssueRef.current = {
    selectionIssue,
    open: issueCreator.open,
    workspaceId,
  };
  const hideToolbar = useCallback((): void => {
    editor.view.dispatch(editor.state.tr.setMeta(formattingToolbarKey, 'hide'));
  }, [editor]);
  subIssueRef.current = (): boolean => {
    const {
      selectionIssue: source,
      open,
      workspaceId: id,
    } = selectionIssueRef.current;
    const parent = source?.parent;
    if (!canCreateSubIssues || parent === undefined || id === undefined) {
      return false;
    }
    hideToolbar();
    return subIssuesFromSelection(editor, id, parent, open);
  };

  const formatContext = useMemo<FormatContext>(
    () => ({
      openLink: () => {
        openLinkRef.current();
      },
      ...(canCreateIssue
        ? {
            createIssue: () => {
              const { selectionIssue: source, open } =
                selectionIssueRef.current;
              if (source === undefined) return;
              hideToolbar();
              createIssueFromSelection(editor, source, open);
            },
          }
        : {}),
      ...(canCreateSubIssues
        ? {
            createSubIssues: () => {
              const { selectionIssue: source, workspaceId: id } =
                selectionIssueRef.current;
              const parent = source?.parent;
              if (parent === undefined || id === undefined) return;
              hideToolbar();
              createSubIssuesFromList(editor, id, parent);
            },
          }
        : {}),
    }),
    [canCreateIssue, canCreateSubIssues, editor, hideToolbar]
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
      {...(showBlockHandles ? { 'data-block-handles': '' } : {})}
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
      {issueHoverCard}
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
          aria-label={
            matches.every((option) => option.kind === 'date')
              ? 'Insert a date'
              : 'Mention someone'
          }
          className="absolute z-20 w-64 overflow-hidden rounded-md border border-line bg-overlay py-1 shadow-overlay"
          style={{ top: mention.top, left: mention.left }}
        >
          {matches.map((option, index) => {
            const rowClass = cn(
              'flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm hover:bg-raised hover:text-text active:bg-line',
              index === highlight ? 'bg-raised text-text' : 'text-text-muted'
            );
            const pick = (event: React.MouseEvent): void => {
              event.preventDefault();
              chooseRef.current(option);
            };
            const hover = (): void => {
              setHighlight(index);
            };
            if (option.kind === 'date') {
              const firstDate = matches[index - 1]?.kind !== 'date';
              return (
                <React.Fragment key={`date-${option.date.value}`}>
                  {firstDate && (
                    <li
                      role="presentation"
                      className={cn(
                        'px-2 pt-1.5 pb-1 text-xs font-medium text-text-faint',
                        index > 0 && 'mt-1 border-t border-line'
                      )}
                    >
                      Date
                    </li>
                  )}
                  <li
                    role="option"
                    aria-selected={index === highlight}
                    className={rowClass}
                    onMouseDown={pick}
                    onMouseEnter={hover}
                  >
                    <LuCalendar aria-hidden className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-text">
                      {option.date.label}
                    </span>
                  </li>
                </React.Fragment>
              );
            }
            const { person } = option;
            return (
              <li
                key={person.user_id}
                role="option"
                aria-selected={index === highlight}
                className={rowClass}
                onMouseDown={pick}
                onMouseEnter={hover}
              >
                <Avatar
                  name={personLabel(person)}
                  src={personAvatar(person)}
                  size="sm"
                  away={isAway(person.user_status)}
                />
                <span className="min-w-0 flex-1 truncate text-text">
                  {personLabel(person)}
                </span>
                {statusSummary(person.user_status) !== '' && (
                  <span
                    className="max-w-32 shrink truncate text-xs text-text-muted"
                    data-testid="mention-status"
                  >
                    {statusSummary(person.user_status)}
                  </span>
                )}
                <span className="shrink-0 text-xs text-text-faint">
                  @{mentionHandle(person)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {blockMenu !== null && blockMenuNode !== null && (
        <BlockMenu
          top={blockMenu.top}
          left={blockMenu.left}
          canTurnInto={canTurnInto(blockMenuNode)}
          onTurnInto={turnInto}
          onDuplicate={() => {
            setBlockMenu(null);
            editor.commands.focus();
            duplicateBlock(editor.state, editor.view.dispatch, blockMenu.pos);
          }}
          onDelete={() => {
            setBlockMenu(null);
            editor.commands.focus();
            deleteBlock(editor.state, editor.view.dispatch, blockMenu.pos);
          }}
          onClose={closeBlockMenu}
          onBlur={(event) => {
            const next = event.relatedTarget as Node | null;
            if (next !== null && surface.current?.contains(next) === true) {
              return;
            }
            setBlockMenu(null);
            handlers.current.onFocusChange?.(false);
            commit();
          }}
        />
      )}
      {datePicker !== null && (
        <DateChipPicker
          top={datePicker.top}
          left={datePicker.left}
          onPick={pickDate}
          onClose={() => {
            setDatePicker(null);
            editor.commands.focus();
          }}
          onBlur={(event) => {
            const next = event.relatedTarget as Node | null;
            if (next !== null && surface.current?.contains(next) === true) {
              return;
            }
            setDatePicker(null);
            handlers.current.onFocusChange?.(false);
            commit();
          }}
        />
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
