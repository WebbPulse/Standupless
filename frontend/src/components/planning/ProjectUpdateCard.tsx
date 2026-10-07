/**
 * One project update in the feed: who wrote it, when, the health they called,
 * and the text as Markdown. The author and a workspace admin edit it in place
 * or delete it from a menu, which is what the server's `can_edit` says.
 *
 * The card carries the element id `update-<id>`, so a link from an email, a
 * webhook or the inbox that ends in that hash scrolls straight to it.
 */

import React, { useState } from 'react';
import { LuCopy, LuEllipsis, LuPencil, LuTrash2 } from 'react-icons/lu';
import { errorMessage } from '../../lib/errors';
import { personLabel, type Assignable } from '../../lib/issuePeople';
import { PROJECT_HEALTH_LABELS } from '../../lib/projectLook';
import { showErrorToast, showToast } from '../../lib/toast';
import type {
  ProjectHealth,
  ProjectUpdateEdit,
  ProjectUpdateRead,
} from '../../types/Api';
import Avatar from '../ui/avatar';
import Button, { IconButton } from '../ui/button';
import Dialog from '../ui/dialog';
import Markdown from '../ui/markdown';
import Menu, { MenuItem, MenuSeparator } from '../ui/menu';
import RelativeTime from '../ui/relative-time';
import ViaSource from '../ui/via-source';
import ProjectHealthGlyph from './ProjectHealthGlyph';
import ProjectUpdateEditor from './ProjectUpdateEditor';

/** The element id an update renders under, so a hash can scroll to it. */
const anchorOf = (updateId: string): string => `update-${updateId}`;

/** Props for HealthPill: the health an update called. */
interface HealthPillProps {
  health: ProjectHealth;
}

/** A health value as a small labelled pill. */
export const HealthPill: React.FC<HealthPillProps> = ({ health }) => (
  <span
    data-health={health}
    className="inline-flex h-5 items-center gap-1 rounded-full border border-line px-1.5 text-2xs text-text-muted"
  >
    <ProjectHealthGlyph health={health} className="h-3 w-3" />
    {PROJECT_HEALTH_LABELS[health]}
  </span>
);

/** Props for ProjectUpdateCard. */
export interface ProjectUpdateCardProps {
  update: ProjectUpdateRead;
  people: Assignable[];
  onEdit: (updateId: string, body: ProjectUpdateEdit) => Promise<unknown>;
  onDelete: (updateId: string) => Promise<unknown>;
}

/** One update, with edit and delete for the people allowed to. */
export const ProjectUpdateCard: React.FC<ProjectUpdateCardProps> = ({
  update,
  people,
  onEdit,
  onDelete,
}) => {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const author = personLabel(
    people.find((person) => person.user_id === update.author_id)
  );

  const save = (body: string, health: ProjectHealth): Promise<boolean> =>
    onEdit(update.update_id, { body, health }).then(
      () => {
        setEditing(false);
        return true;
      },
      (failure: unknown) => {
        showErrorToast(errorMessage(failure, 'Could not save that update.'));
        return false;
      }
    );

  const remove = (): void => {
    setConfirming(false);
    onDelete(update.update_id).then(
      () => {
        showToast('Update deleted');
      },
      (failure: unknown) => {
        showErrorToast(errorMessage(failure, 'Could not delete that update.'));
      }
    );
  };

  const copyLink = (): void => {
    const url = new URL(globalThis.location.href);
    url.searchParams.set('tab', 'updates');
    url.hash = anchorOf(update.update_id);
    void navigator.clipboard
      .writeText(url.toString())
      .then(() => {
        showToast('Link to the update copied');
      })
      .catch(() => {
        showErrorToast('Could not copy the link.');
      });
  };

  return (
    <article
      id={anchorOf(update.update_id)}
      aria-label={`Update by ${author}`}
      className="group/update scroll-mt-4 rounded-lg border border-line bg-surface px-4 py-3"
    >
      <header className="flex items-center gap-2">
        <Avatar name={author} size="sm" />
        <span className="truncate text-sm font-medium text-text">{author}</span>
        <HealthPill health={update.health} />
        <RelativeTime value={update.created_at} />
        <ViaSource source={update.source} />
        {update.edited_at !== null && (
          <span className="text-xs text-text-faint">(edited)</span>
        )}
        <div className="ml-auto flex items-center opacity-0 transition-opacity duration-100 group-focus-within/update:opacity-100 group-hover/update:opacity-100">
          <Menu
            label="Update actions"
            align="end"
            trigger={(props) => (
              <IconButton label="Update actions" size="sm" {...props}>
                <LuEllipsis className="h-3.5 w-3.5" />
              </IconButton>
            )}
          >
            <MenuItem onSelect={copyLink}>
              <LuCopy aria-hidden="true" className="h-3.5 w-3.5" />
              Copy link
            </MenuItem>
            {update.can_edit && (
              <>
                <MenuItem
                  onSelect={() => {
                    setEditing(true);
                  }}
                >
                  <LuPencil aria-hidden="true" className="h-3.5 w-3.5" />
                  Edit
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  danger
                  onSelect={() => {
                    setConfirming(true);
                  }}
                >
                  <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
                  Delete
                </MenuItem>
              </>
            )}
          </Menu>
        </div>
      </header>

      <div className="mt-2 pl-7">
        {editing ? (
          <ProjectUpdateEditor
            people={people}
            initialBody={update.body}
            initialHealth={update.health}
            submitLabel="Save"
            busyLabel="Saving"
            ariaLabel="Edit update"
            autoFocus
            onSubmit={save}
            onCancel={() => {
              setEditing(false);
            }}
          />
        ) : (
          <Markdown source={update.body} density="compact" />
        )}
      </div>

      {confirming && (
        <Dialog
          open
          size="sm"
          title="Delete this update"
          description="It is removed from the project for everyone."
          onClose={() => {
            setConfirming(false);
          }}
        >
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={remove}>
              Delete update
            </Button>
          </div>
        </Dialog>
      )}
    </article>
  );
};

export default ProjectUpdateCard;
