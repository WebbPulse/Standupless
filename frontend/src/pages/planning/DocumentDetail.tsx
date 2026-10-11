/**
 * One document on its own page: the title edits in place, the body is the
 * same rich Markdown surface issues use, and both save as they are written.
 * Every write carries the `updated_at` the page last saw, so an edit made over
 * someone else's newer one is refused and the page offers their version
 * rather than silently replacing it. Earlier versions open in a dialog, and
 * the issues the text names are listed and linked under it.
 */

import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import {
  LuChevronRight,
  LuEllipsis,
  LuFileText,
  LuHistory,
  LuTrash2,
} from 'react-icons/lu';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  deleteDocument,
  getDocument,
  listDocumentVersions,
  updateDocument,
} from '../../api/documents';
import type { RichMarkdownHandle } from '../../components/editor/RichMarkdownEditor';
import EditableText from '../../components/planning/EditableText';
import { ErrorAlert } from '../../components/ui/alert';
import Button, { IconButton } from '../../components/ui/button';
import Dialog from '../../components/ui/dialog';
import EmptyState from '../../components/ui/empty-state';
import Markdown from '../../components/ui/markdown';
import Menu, { MenuItem, MenuSeparator } from '../../components/ui/menu';
import RelativeTime from '../../components/ui/relative-time';
import { SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { refreshDocumentLists } from '../../hooks/useDocuments';
import { useWorkspace } from '../../hooks/useWorkspace';
import { useWorkspaceMembers } from '../../hooks/useWorkspaceMembers';
import { CONFLICT, errorMessage, hasStatus } from '../../lib/errors';
import { personLabel, type Assignable } from '../../lib/issuePeople';
import { initiativePath, issuePath, projectPath } from '../../lib/paths';
import {
  documentKey,
  documentVersionsKey,
  issueDocumentsKey,
} from '../../lib/queryKeys';
import { showToast } from '../../lib/toast';
import type { DocumentPatch, DocumentRead } from '../../types/Api';

const RichMarkdownEditor = lazy(
  () => import('../../components/editor/RichMarkdownEditor')
);

/** How often the page re-reads, which is how another editor's change shows. */
const POLL_MS = 15000;

/** How long typing pauses before the body saves on its own. */
const AUTOSAVE_MS = 1500;

/** The longest title a document may carry, as the server holds it. */
const TITLE_MAX = 200;

/** The body text as prose, matching the issue description. */
const BODY_CLASS = 'text-sm leading-6 text-text';

/** Where the save stands, as the line under the title says it. */
type SaveState = 'idle' | 'saving' | 'saved' | 'failed' | 'conflict';

/** The words the save line shows for each state. */
const SAVE_LABEL: Record<SaveState, string> = {
  idle: '',
  saving: 'Saving',
  saved: 'Saved',
  failed: 'Not saved',
  conflict: 'Edited elsewhere',
};

/** Whichever of two reads of the document is the newer. */
const newer = (
  one: DocumentRead | null,
  other: DocumentRead | null
): DocumentRead | null => {
  if (one === null) return other;
  if (other === null) return one;
  return other.updated_at > one.updated_at ? other : one;
};

/** The page's own link to the project or initiative a document sits under. */
const parentLink = (slug: string, page: DocumentRead): string =>
  page.parent_kind === 'project'
    ? projectPath(slug, page.parent_id)
    : initiativePath(slug, page.parent_id);

/** The dialog listing a document's earlier versions, each readable in full. */
const VersionsDialog: React.FC<{
  workspaceId: string;
  documentId: string;
  people: Assignable[];
  onClose: () => void;
}> = ({ workspaceId, documentId, people, onClose }) => {
  const auth = useQueryAuth();
  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listDocumentVersions(workspaceId, documentId, signal),
    {
      intervalMs: POLL_MS,
      queryKey: documentVersionsKey(workspaceId, documentId),
      auth,
    }
  );
  const versions = data ?? [];
  return (
    <Dialog open size="lg" title="Version history" onClose={onClose}>
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the history.')}
        />
      )}
      {isLoading && data === null && <SkeletonRows label="Loading versions" />}
      {data !== null && versions.length === 0 && (
        <p className="text-sm text-text-muted">
          No earlier versions yet. A version is kept when someone else edits the
          document, or after a pause in editing.
        </p>
      )}
      {versions.length > 0 && (
        <ol
          aria-label="Versions"
          className="max-h-[60vh] space-y-1 overflow-y-auto"
        >
          {versions.map((version) => (
            <li key={version.version_id}>
              <details className="group rounded-md border border-line">
                <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-text hover:bg-surface">
                  <span className="truncate font-medium">{version.title}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-text-muted">
                    {personLabel(
                      people.find(
                        (person) => person.user_id === version.edited_by
                      )
                    )}
                    <span aria-hidden="true">·</span>
                    <RelativeTime value={version.edited_at} />
                  </span>
                </summary>
                <div className="border-t border-line px-3 py-3">
                  {version.body === '' ? (
                    <p className="text-sm text-text-muted">Empty.</p>
                  ) : (
                    <Markdown source={version.body} className={BODY_CLASS} />
                  )}
                </div>
              </details>
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
};

/** The page. */
export const DocumentDetail: React.FC = () => {
  const { documentId = '' } = useParams<{ documentId: string }>();
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const auth = useQueryAuth();
  const workspaceId = workspace?.id ?? '';
  const slug = workspace?.slug ?? '';
  const isMember = workspace !== null && workspace.role !== 'guest';
  const people = useWorkspaceMembers(workspaceId, isMember);

  const { data, error, isLoading, refetch } = usePolledQuery(
    ({ signal }) => getDocument(workspaceId, documentId, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '' && documentId !== '',
      queryKey: documentKey(workspaceId, documentId),
      auth,
    }
  );

  const [local, setLocal] = useState<DocumentRead | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<unknown>(null);
  const [showVersions, setShowVersions] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const editor = useRef<RichMarkdownHandle>(null);
  const base = useRef<string | null>(null);
  const savedBody = useRef<string | null>(null);
  const pendingBody = useRef<string | null>(null);
  const conflicted = useRef(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const page = newer(local, data);

  useEffect(() => {
    if (data === null) return;
    const unsaved =
      pendingBody.current !== null && pendingBody.current !== savedBody.current;
    if (unsaved) return;
    if (base.current === null || data.updated_at > base.current) {
      base.current = data.updated_at;
      savedBody.current = data.body;
    }
  }, [data]);

  useEffect(() => {
    const pending = timer;
    return () => {
      if (pending.current !== null) clearTimeout(pending.current);
    };
  }, []);

  const write = useCallback(
    (patch: DocumentPatch): Promise<boolean> => {
      const run = async (): Promise<boolean> => {
        if (conflicted.current) return false;
        if (patch.body !== undefined && patch.title === undefined) {
          if (patch.body === savedBody.current) return true;
        }
        setSaveState('saving');
        try {
          const saved = await updateDocument(workspaceId, documentId, {
            ...patch,
            ...(base.current === null ? {} : { base_updated_at: base.current }),
          });
          base.current = saved.updated_at;
          savedBody.current = saved.body;
          setLocal(saved);
          setSaveError(null);
          setSaveState('saved');
          if (patch.title !== undefined) {
            refreshDocumentLists(
              workspaceId,
              saved.parent_kind,
              saved.parent_id,
              saved.document_id
            );
          }
          if (patch.body !== undefined) {
            for (const mention of saved.mentions) {
              invalidateQueries(
                issueDocumentsKey(workspaceId, mention.issue_id)
              );
            }
          }
          return true;
        } catch (problem) {
          if (hasStatus(problem, CONFLICT)) {
            conflicted.current = true;
            setSaveState('conflict');
          } else {
            setSaveError(problem);
            setSaveState('failed');
          }
          return false;
        }
      };
      const next = queue.current.then(run, run);
      queue.current = next;
      return next;
    },
    [workspaceId, documentId]
  );

  const saveBody = useCallback(
    (markdown: string): Promise<boolean> => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      pendingBody.current = markdown;
      return write({ body: markdown });
    },
    [write]
  );

  const scheduleSave = useCallback(
    (markdown: string, uploading: boolean): void => {
      pendingBody.current = markdown;
      if (timer.current !== null) clearTimeout(timer.current);
      if (uploading) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        void write({ body: markdown });
      }, AUTOSAVE_MS);
    },
    [write]
  );

  const reload = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    pendingBody.current = null;
    void getDocument(workspaceId, documentId)
      .then((fresh) => {
        conflicted.current = false;
        base.current = fresh.updated_at;
        savedBody.current = fresh.body;
        setLocal(fresh);
        setSaveError(null);
        setSaveState('idle');
        editor.current?.setMarkdown(fresh.body);
        void refetch();
      })
      .catch((problem: unknown) => {
        setSaveError(problem);
      });
  };

  const crumbs =
    page === null ? null : (
      <span className="hidden shrink-0 items-center gap-1 text-sm text-text-muted sm:inline-flex">
        <Link
          to={parentLink(slug, page)}
          className="max-w-48 truncate rounded-xs hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
        >
          {page.parent_name}
        </Link>
        <LuChevronRight
          className="h-3.5 w-3.5 text-text-faint"
          aria-hidden="true"
        />
      </span>
    );

  if (page === null && (isLoading || workspace === null)) {
    return (
      <WorkspaceShell title="Document">
        <SkeletonRows label="Loading document" />
      </WorkspaceShell>
    );
  }

  if (page === null) {
    return (
      <WorkspaceShell title="Document not found">
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load this document.')}
          />
        )}
        <EmptyState message="That document does not exist, or you do not have access to it." />
      </WorkspaceShell>
    );
  }

  const remove = (): void => {
    setConfirmingDelete(false);
    void deleteDocument(workspaceId, page.document_id)
      .then(() => {
        refreshDocumentLists(workspaceId, page.parent_kind, page.parent_id);
        showToast(`Deleted ${page.title}`);
        void navigate(parentLink(slug, page));
      })
      .catch((problem: unknown) => {
        setSaveError(problem);
      });
  };

  const author = people.find((person) => person.user_id === page.author_id);
  const editorPerson = people.find(
    (person) => person.user_id === page.updated_by
  );

  return (
    <WorkspaceShell
      title={
        <span className="flex min-w-0 items-center gap-1.5">
          <LuFileText
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-text-faint"
          />
          <span className="truncate">{page.title}</span>
        </span>
      }
      leading={crumbs}
      flush
      actions={
        <span className="flex items-center gap-2">
          {saveState !== 'idle' && (
            <span role="status" className="text-xs text-text-faint">
              {SAVE_LABEL[saveState]}
            </span>
          )}
          <Menu
            label="Document actions"
            align="end"
            trigger={(trigger) => (
              <IconButton label="Document actions" size="sm" {...trigger}>
                <LuEllipsis className="h-3.5 w-3.5" />
              </IconButton>
            )}
          >
            <MenuItem
              onSelect={() => {
                setShowVersions(true);
              }}
            >
              <LuHistory aria-hidden="true" className="h-3.5 w-3.5" />
              Version history
            </MenuItem>
            {page.can_delete && (
              <>
                <MenuSeparator />
                <MenuItem
                  danger
                  onSelect={() => {
                    setConfirmingDelete(true);
                  }}
                >
                  <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
                  Delete document
                </MenuItem>
              </>
            )}
          </Menu>
        </span>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <article className="mx-auto max-w-3xl space-y-6 px-4 py-8 lg:px-8">
          {saveState === 'conflict' && (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface px-3 py-2 text-sm text-text"
            >
              <span>
                Someone else saved this document after you opened it. Your
                latest changes were not saved.
              </span>
              <Button size="sm" variant="secondary" onClick={reload}>
                Load their version
              </Button>
            </div>
          )}
          {saveError !== null && (
            <ErrorAlert
              message={errorMessage(saveError, 'Could not save that edit.')}
            />
          )}
          <header className="space-y-2">
            <EditableText
              label="Document title"
              placeholder="Untitled"
              value={page.title}
              disabled={!page.can_edit}
              className="text-2xl font-semibold"
              onSave={(title) => {
                if (title !== '')
                  void write({ title: title.slice(0, TITLE_MAX) });
              }}
            />
            <p className="flex flex-wrap items-center gap-1 text-xs text-text-muted">
              <span>{`By ${personLabel(author)}`}</span>
              <span aria-hidden="true">·</span>
              <span>
                {page.updated_by === page.author_id
                  ? 'Updated '
                  : `Updated by ${personLabel(editorPerson)} `}
                <RelativeTime value={page.updated_at} />
              </span>
            </p>
          </header>
          <Suspense
            fallback={
              page.body === '' ? (
                <p className={`${BODY_CLASS} text-text-muted`}>
                  {page.can_edit ? 'Start writing...' : 'This page is empty.'}
                </p>
              ) : (
                <Markdown source={page.body} className={BODY_CLASS} />
              )
            }
          >
            <RichMarkdownEditor
              ref={editor}
              value={page.body}
              editable={page.can_edit}
              ariaLabel="Document"
              className={`${BODY_CLASS} min-h-48`}
              onCommit={saveBody}
              onChange={scheduleSave}
              onCancel={() => {
                editor.current?.focus();
              }}
              {...(page.can_edit ? { placeholder: 'Start writing...' } : {})}
              {...(isMember ? { mentionPeople: people } : {})}
            />
          </Suspense>
          {page.mentions.length > 0 && (
            <section
              aria-labelledby="document-mentions"
              className="space-y-2 border-t border-line pt-4"
            >
              <h2
                id="document-mentions"
                className="text-xs font-medium text-text-muted"
              >
                Mentioned issues
              </h2>
              <ul className="flex flex-wrap gap-1.5">
                {page.mentions.map((mention) => (
                  <li key={mention.issue_id}>
                    <Link
                      to={issuePath(slug, mention.key)}
                      className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-xs text-text hover:bg-surface focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
                    >
                      {mention.key}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </article>
      </div>

      {showVersions && (
        <VersionsDialog
          workspaceId={workspaceId}
          documentId={page.document_id}
          people={people}
          onClose={() => {
            setShowVersions(false);
          }}
        />
      )}

      {confirmingDelete && (
        <Dialog
          open
          size="sm"
          title={`Delete ${page.title}`}
          description="The document and its version history are deleted for everyone."
          onClose={() => {
            setConfirmingDelete(false);
          }}
        >
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmingDelete(false);
              }}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={remove}>
              Delete
            </Button>
          </div>
        </Dialog>
      )}
    </WorkspaceShell>
  );
};

export default DocumentDetail;
