/**
 * Writes a project update: the same rich Markdown surface comments use, with
 * @mentions from the project's people, and a row of the three health values
 * under it so every update says how the project is doing. Ctrl or Cmd Enter
 * submits and Escape cancels.
 *
 * Attachments belong to issues, so an update carries text only and the
 * paperclip comments offer is left out.
 *
 * When document templates are offered, a template menu beside the health row
 * replaces the text with a template's body, so a team's usual headings are a
 * click away. The composer may also open on a default template's body.
 *
 * A reply on an update uses the same editor with the health row left out.
 *
 * A project update's editor also offers "Hide details", which keeps the
 * progress report the server attaches to the update out of sight for everyone.
 *
 * Given a draft target, the composer keeps the caller's unposted text and
 * health on the server: it restores them when it opens, saves after a pause,
 * and clears them once the update posts. Editing a posted update passes no
 * target and keeps no draft.
 *
 * A reply box given a reply draft keeps the caller's unposted reply the same
 * way, as a comment draft on that update's thread, and clears it once the
 * reply posts.
 *
 * The editor is its own lazily loaded chunk, so a stand in with the same shape
 * shows until it arrives.
 */

import React, { Suspense, lazy, useCallback, useRef, useState } from 'react';
import { LuChevronDown, LuFileText } from 'react-icons/lu';
import type { CommentDraftParent, UpdateDraftTarget } from '../../api/drafts';
import { useCommentDraft } from '../../hooks/useCommentDraft';
import { useUpdateDraft } from '../../hooks/useUpdateDraft';
import { cn } from '../../lib/cn';
import type { Assignable } from '../../lib/issuePeople';
import { submitKeysLabel } from '../../lib/platform';
import { PROJECT_HEALTHS, PROJECT_HEALTH_LABELS } from '../../lib/projectLook';
import type { ProjectHealth, TemplateRead } from '../../types/Api';
import type { RichMarkdownHandle } from '../editor/RichMarkdownEditor';
import Button from '../ui/button';
import Checkbox from '../ui/checkbox';
import Menu, { MenuItem } from '../ui/menu';
import ProjectHealthGlyph from './ProjectHealthGlyph';

const RichMarkdownEditor = lazy(() => import('../editor/RichMarkdownEditor'));

/** Props for HealthChooser: the chosen health and how to change it. */
export interface HealthChooserProps {
  value: ProjectHealth;
  onChange: (health: ProjectHealth) => void;
  disabled?: boolean;
}

/** The three health values as one segmented radio group. */
export const HealthChooser: React.FC<HealthChooserProps> = ({
  value,
  onChange,
  disabled = false,
}) => (
  <div
    role="radiogroup"
    aria-label="Project health"
    className="inline-flex items-center gap-0.5 rounded-md border border-line bg-bg p-0.5"
  >
    {PROJECT_HEALTHS.map((health) => (
      <button
        key={health}
        type="button"
        role="radio"
        aria-checked={value === health}
        disabled={disabled}
        onClick={() => {
          onChange(health);
        }}
        className={cn(
          'inline-flex h-6 items-center gap-1.5 rounded-sm px-2 text-xs transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none disabled:opacity-50',
          value === health
            ? 'bg-raised text-text'
            : 'text-text-muted hover:bg-surface hover:text-text'
        )}
      >
        <ProjectHealthGlyph health={health} />
        {PROJECT_HEALTH_LABELS[health]}
      </button>
    ))}
  </div>
);

/** Props for ProjectUpdateEditor. */
export interface ProjectUpdateEditorProps {
  /** The people a mention can name. */
  people: Assignable[];
  /** The text the editor opens with. */
  initialBody?: string;
  /** The health the chooser opens on. */
  initialHealth: ProjectHealth;
  /** The label of the submit button, and of its busy state. */
  submitLabel: string;
  busyLabel: string;
  ariaLabel: string;
  placeholder?: string;
  autoFocus?: boolean;
  /** Called with the trimmed text, the health and the Hide details choice. Resolves true once saved. */
  onSubmit: (
    body: string,
    health: ProjectHealth,
    hideDetails: boolean
  ) => Promise<boolean>;
  onCancel?: () => void;
  /** Clears the text after a successful submit, for a composer that stays open. */
  clearOnSubmit?: boolean;
  /** The document templates the menu offers; the menu hides when empty. */
  templates?: TemplateRead[];
  /** Shows the health chooser; a reply has no health of its own. */
  withHealth?: boolean;
  /** Shows the Hide details toggle; only a project update carries a progress report. */
  withDetailsToggle?: boolean;
  /** Whether Hide details starts on. */
  initialHideDetails?: boolean;
  /** The project or initiative whose server side draft the composer keeps; none keeps no draft. */
  draftTarget?: UpdateDraftTarget;
  /** The update thread whose comment draft a reply box keeps; none keeps no reply draft. */
  replyDraft?: ReplyDraftTarget;
}

/** The update thread a reply box keeps the caller's comment draft on. */
export interface ReplyDraftTarget {
  workspaceId: string;
  parent: CommentDraftParent;
}

const NO_REPLY_PARENT: CommentDraftParent = { kind: 'issue', id: '' };

/** A Markdown box and a health chooser that submit together. */
export const ProjectUpdateEditor: React.FC<ProjectUpdateEditorProps> = ({
  people,
  initialBody = '',
  initialHealth,
  submitLabel,
  busyLabel,
  ariaLabel,
  placeholder = 'Write a project update...',
  autoFocus = false,
  onSubmit,
  onCancel,
  clearOnSubmit = false,
  templates = [],
  withHealth = true,
  withDetailsToggle = false,
  initialHideDetails = false,
  draftTarget,
  replyDraft,
}) => {
  const [draft, setDraft] = useState(initialBody);
  const [health, setHealth] = useState<ProjectHealth>(initialHealth);
  const [hideDetails, setHideDetails] = useState(initialHideDetails);
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const editor = useRef<RichMarkdownHandle>(null);
  const serverDraft = useUpdateDraft(draftTarget, editor, {
    initialBody,
    onRestore: (saved) => {
      setDraft(saved.body);
      const restoredHealth = saved.health ?? null;
      if (withHealth && restoredHealth !== null) setHealth(restoredHealth);
    },
  });

  const commentDraft = useCommentDraft(
    replyDraft?.workspaceId ?? '',
    replyDraft?.parent ?? NO_REPLY_PARENT,
    undefined,
    editor,
    replyDraft !== undefined
  );
  const { ref: updateDraftRef } = serverDraft;
  const { ref: replyDraftRef } = commentDraft;
  const editorRef = useCallback(
    (handle: RichMarkdownHandle | null): void => {
      updateDraftRef(handle);
      replyDraftRef(handle);
    },
    [updateDraftRef, replyDraftRef]
  );

  const pickHealth = (picked: ProjectHealth): void => {
    setHealth(picked);
    serverDraft.pickHealth(picked);
  };

  const canSubmit = !busy && draft.trim() !== '';

  const submit = (): void => {
    const body = (editor.current?.getMarkdown() ?? draft).trim();
    if (busy || body === '') return;
    setBusy(true);
    void onSubmit(body, health, hideDetails).then((saved) => {
      setBusy(false);
      if (saved) {
        serverDraft.clear();
        commentDraft.clear();
      }
      if (saved && clearOnSubmit) {
        editor.current?.setMarkdown('');
        setDraft('');
        setHideDetails(initialHideDetails);
      }
    });
  };

  const applyTemplate = (template: TemplateRead): void => {
    const body = template.body ?? '';
    editor.current?.setMarkdown(body);
    setDraft(body);
    serverDraft.save(body);
    commentDraft.save(body);
  };

  const usable = templates.filter(
    (template) => (template.body ?? '').trim() !== ''
  );

  const textClass = cn(
    withHealth ? 'min-h-24' : 'min-h-14',
    'px-3 pt-3 pb-1 text-sm leading-5.5'
  );

  return (
    <div
      className={cn(
        'rounded-lg border bg-surface transition-colors duration-100',
        focused ? 'border-line-strong' : 'border-line'
      )}
    >
      <Suspense
        fallback={
          <p className={cn(textClass, 'text-text-faint')}>{placeholder}</p>
        }
      >
        <RichMarkdownEditor
          ref={editorRef}
          value={initialBody}
          editable
          ariaLabel={ariaLabel}
          placeholder={placeholder}
          autoFocus={autoFocus}
          className={textClass}
          density="compact"
          mentionPeople={people}
          onCommit={() => false}
          onChange={(markdown) => {
            setDraft(markdown);
            serverDraft.save(markdown);
            commentDraft.save(markdown);
          }}
          onSubmit={submit}
          onFocusChange={setFocused}
          {...(onCancel === undefined ? {} : { onCancel })}
        />
      </Suspense>
      <div className="flex flex-wrap items-center gap-2 px-2 pb-2">
        {withHealth && (
          <HealthChooser value={health} onChange={pickHealth} disabled={busy} />
        )}
        {usable.length > 0 && (
          <Menu
            label="Update templates"
            trigger={(trigger) => (
              <Button variant="ghost" size="sm" disabled={busy} {...trigger}>
                <LuFileText aria-hidden="true" className="h-3.5 w-3.5" />
                Template
                <LuChevronDown aria-hidden="true" className="h-3 w-3" />
              </Button>
            )}
          >
            {usable.map((template) => (
              <MenuItem
                key={template.id}
                textValue={template.name}
                onSelect={() => {
                  applyTemplate(template);
                }}
              >
                {template.name}
              </MenuItem>
            ))}
          </Menu>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {withDetailsToggle && (
            <Checkbox
              label="Hide details"
              checked={hideDetails}
              disabled={busy}
              onChange={(event) => {
                setHideDetails(event.target.checked);
              }}
              className="mr-1 text-xs text-text-muted"
              title="Hide the progress report on this update for everyone"
            />
          )}
          {onCancel !== undefined && (
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button
            variant={canSubmit ? 'primary' : 'secondary'}
            size="sm"
            disabled={!canSubmit}
            onClick={submit}
          >
            {busy ? busyLabel : submitLabel}
            <span className="hidden text-2xs opacity-70 sm:inline">
              {submitKeysLabel()}
            </span>
          </Button>
        </div>
      </div>
    </div>
  );
};

export default ProjectUpdateEditor;
