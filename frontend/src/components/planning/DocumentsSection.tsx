/**
 * The documents under a project or an initiative, on its overview: specs,
 * plans and notes written in Markdown, each opening on its own page. A new
 * document is created untitled and opened straight away, the way a blank page
 * is started, and a row renames or deletes in place.
 */

import React, { useState } from 'react';
import {
  LuEllipsis,
  LuFileText,
  LuPencil,
  LuPlus,
  LuTrash2,
} from 'react-icons/lu';
import { Link, useNavigate } from 'react-router-dom';
import useDocuments from '../../hooks/useDocuments';
import { personLabel, type Assignable } from '../../lib/issuePeople';
import { documentPath } from '../../lib/paths';
import { showToast } from '../../lib/toast';
import type { DocumentParentKind, DocumentSummaryRead } from '../../types/Api';
import { Button, IconButton } from '../ui/button';
import Dialog from '../ui/dialog';
import Menu, { MenuItem, MenuSeparator } from '../ui/menu';
import RelativeTime from '../ui/relative-time';

/** The longest title a document may carry, as the server holds it. */
const TITLE_MAX = 200;

/** The title a new document starts with until it is named. */
const UNTITLED = 'Untitled';

/** Props for DocumentsSection. */
export interface DocumentsSectionProps {
  workspaceId: string;
  slug: string;
  parentKind: DocumentParentKind;
  parentId: string;
  /** Whether the caller may write under the parent. */
  canCreate: boolean;
  /** The people author ids resolve against. */
  people: Assignable[];
}

/** The field a document is renamed in, saved on Enter or blur. */
const RenameField: React.FC<{
  row: DocumentSummaryRead;
  onSave: (title: string) => void;
  onDone: () => void;
}> = ({ row, onSave, onDone }) => {
  const [title, setTitle] = useState(row.title);
  const save = (): void => {
    const trimmed = title.trim();
    if (trimmed !== '' && trimmed !== row.title) {
      onSave(trimmed.slice(0, TITLE_MAX));
    }
    onDone();
  };
  return (
    <input
      aria-label={`Rename ${row.title}`}
      autoFocus
      maxLength={TITLE_MAX}
      value={title}
      onChange={(event) => {
        setTitle(event.target.value);
      }}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          save();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          onDone();
        }
      }}
      className="w-full bg-transparent text-sm text-text focus:outline-none"
    />
  );
};

/** The section. */
export const DocumentsSection: React.FC<DocumentsSectionProps> = ({
  workspaceId,
  slug,
  parentKind,
  parentId,
  canCreate,
  people,
}) => {
  const navigate = useNavigate();
  const { documents, isLoading, create, rename, remove } = useDocuments(
    workspaceId,
    parentKind,
    parentId
  );
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DocumentSummaryRead | null>(null);

  const start = (): void => {
    if (creating) return;
    setCreating(true);
    void create(UNTITLED).then((made) => {
      setCreating(false);
      if (made !== null) {
        void navigate(documentPath(slug, made.document_id));
      }
    });
  };

  const authorOf = (row: DocumentSummaryRead): string =>
    personLabel(people.find((person) => person.user_id === row.author_id));

  const headingId = `${parentKind}-documents`;
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 id={headingId} className="text-sm font-medium text-text">
          Documents
        </h2>
        {canCreate && (
          <IconButton
            label="New document"
            size="sm"
            disabled={creating}
            onClick={start}
          >
            <LuPlus className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
      {documents.length === 0 && !isLoading && (
        <p className="text-xs text-text-muted">
          {canCreate
            ? `Write specs, plans and notes for this ${parentKind} in Markdown.`
            : `This ${parentKind} has no documents.`}
        </p>
      )}
      {documents.length > 0 && (
        <ul aria-label="Documents" className="-mx-1.5">
          {documents.map((row) => (
            <li
              key={row.document_id}
              className="group/document grid grid-cols-[1rem_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-surface"
            >
              <LuFileText
                aria-hidden="true"
                className="h-3.5 w-3.5 text-text-faint"
              />
              {renaming === row.document_id ? (
                <RenameField
                  row={row}
                  onSave={(title) => {
                    void rename(row.document_id, title);
                  }}
                  onDone={() => {
                    setRenaming(null);
                  }}
                />
              ) : (
                <Link
                  to={documentPath(slug, row.document_id)}
                  className="truncate rounded-xs text-sm text-text hover:underline focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
                >
                  {row.title}
                </Link>
              )}
              <span className="flex items-center gap-1 text-xs text-text-muted">
                <span className="hidden truncate sm:inline">
                  {authorOf(row)}
                </span>
                <span aria-hidden="true" className="hidden sm:inline">
                  ·
                </span>
                <RelativeTime value={row.updated_at} />
              </span>
              {row.can_edit || row.can_delete ? (
                <Menu
                  label={`${row.title} actions`}
                  align="end"
                  trigger={(trigger) => (
                    <IconButton
                      label={`${row.title} actions`}
                      size="sm"
                      className="opacity-0 group-hover/document:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100"
                      {...trigger}
                    >
                      <LuEllipsis className="h-3.5 w-3.5" />
                    </IconButton>
                  )}
                >
                  {row.can_edit && (
                    <MenuItem
                      onSelect={() => {
                        setRenaming(row.document_id);
                      }}
                    >
                      <LuPencil aria-hidden="true" className="h-3.5 w-3.5" />
                      Rename
                    </MenuItem>
                  )}
                  {row.can_delete && (
                    <>
                      <MenuSeparator />
                      <MenuItem
                        danger
                        onSelect={() => {
                          setDeleting(row);
                        }}
                      >
                        <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
                        Delete document
                      </MenuItem>
                    </>
                  )}
                </Menu>
              ) : (
                <span />
              )}
            </li>
          ))}
        </ul>
      )}
      {deleting !== null && (
        <Dialog
          open
          size="sm"
          title={`Delete ${deleting.title}`}
          description="The document and its version history are deleted for everyone."
          onClose={() => {
            setDeleting(null);
          }}
        >
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setDeleting(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const target = deleting;
                setDeleting(null);
                void remove(target.document_id).then((done) => {
                  if (done) showToast(`Deleted ${target.title}`);
                });
              }}
            >
              Delete
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
};

export default DocumentsSection;
