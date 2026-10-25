/**
 * A project's overview, the description under its name, written on the same
 * rich Markdown surface issue descriptions and documents use, block grips
 * included. It saves itself as it is written, after a pause in typing or when
 * focus leaves, and every save carries the version of the text it started
 * from, so a save made over someone else's newer overview is refused and
 * offered back as a choice instead of silently replacing their words.
 */

import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ApiError } from '@webbpulse/api-client';
import { updateProject } from '../../api/planning';
import { copyText } from '../../lib/copyIssue';
import { errorCode, errorMessage } from '../../lib/errors';
import type { Assignable } from '../../lib/issuePeople';
import { showErrorToast } from '../../lib/toast';
import type { ProjectRead } from '../../types/Api';
import BodyConflictBanner from '../editor/BodyConflictBanner';
import type { RichMarkdownHandle } from '../editor/RichMarkdownEditor';
import Markdown from '../ui/markdown';

const RichMarkdownEditor = lazy(() => import('../editor/RichMarkdownEditor'));

/** How long typing pauses before the overview saves on its own. */
export const OVERVIEW_AUTOSAVE_MS = 1500;

/** The code a save made against an older overview is refused with. */
export const BODY_CHANGED = 'BODY_CHANGED';

/** The overview text, set as prose under the project name. */
const BODY_CLASS = 'text-sm leading-6 text-text';

/** The words an empty overview shows to someone who may write one. */
const PLACEHOLDER = 'Add a description, the goal and what done looks like...';

/** The overview and its version as another person saved them. */
interface Theirs {
  body: string;
  version: string;
}

/** Props for ProjectOverviewEditor: the project, who may edit, and the save hook. */
export interface ProjectOverviewEditorProps {
  workspaceId: string;
  project: ProjectRead;
  canEdit: boolean;
  /** The people an @mention in the overview can name. */
  people?: Assignable[];
  /** Told the project as the server answered a save, so the page can refresh. */
  onSaved?: (project: ProjectRead) => void;
}

/** The overview and version a `BODY_CHANGED` refusal carried, or null for any other failure. */
export const theirsFrom = (failure: unknown): Theirs | null => {
  if (!(failure instanceof ApiError) || errorCode(failure) !== BODY_CHANGED) {
    return null;
  }
  const body: unknown = failure.body;
  const details =
    typeof body === 'object' && body !== null && 'details' in body
      ? (body as { details?: unknown }).details
      : undefined;
  if (typeof details !== 'object' || details === null) return null;
  const fields = details as { body?: unknown; body_version?: unknown };
  if (
    typeof fields.body !== 'string' ||
    typeof fields.body_version !== 'string'
  ) {
    return null;
  }
  return { body: fields.body, version: fields.body_version };
};

/** The project overview, editable in place for a project editor. */
export const ProjectOverviewEditor: React.FC<ProjectOverviewEditorProps> = ({
  workspaceId,
  project,
  canEdit,
  people,
  onSaved,
}) => {
  const serverBody = project.description ?? '';
  const serverVersion = project.body_version ?? '';
  const serverAt = project.updated_at;
  const [body, setBody] = useState(serverBody);
  const [theirs, setTheirs] = useState<Theirs | null>(null);
  const [resolving, setResolving] = useState(false);
  const editor = useRef<RichMarkdownHandle>(null);
  const savedBody = useRef(serverBody);
  const version = useRef(serverVersion);
  const seenAt = useRef(serverAt);
  const pending = useRef<string | null>(null);
  const conflicted = useRef(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedHook = useRef(onSaved);
  savedHook.current = onSaved;

  useEffect(() => {
    if (conflicted.current) return;
    if (pending.current !== null && pending.current !== savedBody.current) {
      return;
    }
    if (serverVersion === version.current) return;
    if (serverAt <= seenAt.current) return;
    seenAt.current = serverAt;
    version.current = serverVersion;
    savedBody.current = serverBody;
    setBody(serverBody);
  }, [serverBody, serverVersion, serverAt]);

  useEffect(() => {
    const scheduled = timer;
    return () => {
      if (scheduled.current !== null) clearTimeout(scheduled.current);
    };
  }, []);

  const write = useCallback(
    (markdown: string): Promise<boolean> => {
      const run = async (): Promise<boolean> => {
        if (conflicted.current) return false;
        if (markdown === savedBody.current) return true;
        try {
          const saved = await updateProject(workspaceId, project.project_id, {
            description: markdown === '' ? null : markdown,
            ...(version.current === ''
              ? {}
              : { base_body_version: version.current }),
          });
          savedBody.current = saved.description ?? '';
          version.current = saved.body_version ?? '';
          if (saved.updated_at > seenAt.current) {
            seenAt.current = saved.updated_at;
          }
          setBody(savedBody.current);
          savedHook.current?.(saved);
          return true;
        } catch (failure) {
          const refused = theirsFrom(failure);
          if (refused !== null) {
            conflicted.current = true;
            setTheirs(refused);
          } else {
            showErrorToast(
              errorMessage(failure, 'Could not save the description.')
            );
          }
          return false;
        }
      };
      const next = queue.current.then(run, run);
      queue.current = next;
      return next;
    },
    [workspaceId, project.project_id]
  );

  const cancelTimer = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  const commit = useCallback(
    (markdown: string): Promise<boolean> => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      pending.current = markdown;
      return write(markdown);
    },
    [write]
  );

  const schedule = useCallback(
    (markdown: string, uploading: boolean): void => {
      pending.current = markdown;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      if (uploading) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        void write(markdown);
      }, OVERVIEW_AUTOSAVE_MS);
    },
    [write]
  );

  const loadTheirs = (): void => {
    if (theirs === null) return;
    cancelTimer();
    const mine = pending.current ?? body;
    if (mine !== '') copyText(mine, 'Copied your version to the clipboard.');
    conflicted.current = false;
    pending.current = null;
    savedBody.current = theirs.body;
    version.current = theirs.version;
    setBody(theirs.body);
    editor.current?.setMarkdown(theirs.body);
    setTheirs(null);
  };

  const keepMine = (): void => {
    if (theirs === null) return;
    cancelTimer();
    const mine = pending.current ?? body;
    conflicted.current = false;
    savedBody.current = theirs.body;
    version.current = theirs.version;
    setTheirs(null);
    setResolving(true);
    void write(mine).finally(() => {
      setResolving(false);
    });
  };

  return (
    <div className="space-y-2">
      {theirs !== null && (
        <BodyConflictBanner
          onLoadTheirs={loadTheirs}
          onKeepMine={keepMine}
          busy={resolving}
        />
      )}
      <Suspense
        fallback={
          body === '' ? (
            <p className={`${BODY_CLASS} text-text-muted`}>
              {canEdit ? PLACEHOLDER : 'No description.'}
            </p>
          ) : (
            <Markdown source={body} className={BODY_CLASS} />
          )
        }
      >
        <RichMarkdownEditor
          ref={editor}
          value={body}
          editable={canEdit}
          ariaLabel="Description"
          className={`${BODY_CLASS} min-h-12`}
          blockHandles
          onCommit={commit}
          onChange={schedule}
          {...(canEdit ? { placeholder: PLACEHOLDER } : {})}
          {...(canEdit ? { selectionIssue: { teamId: project.team_id } } : {})}
          {...(people === undefined ? {} : { mentionPeople: people })}
        />
      </Suspense>
    </div>
  );
};

export default ProjectOverviewEditor;
