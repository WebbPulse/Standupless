/**
 * One project update in the feed: who wrote it, when, the health they called,
 * and the text as Markdown. The author and a workspace admin edit it in place
 * or delete it from a menu, which is what the server's `can_edit` says.
 *
 * A project update also carries its thread, as Linear's do: a reaction bar
 * with counts, the reader's own reactions pressed, and a reply toggle naming
 * how many replies there are, which opens the replies and a reply box under
 * the update. An initiative update has no thread, so it shows neither.
 *
 * Under a project update's text sits its progress report: what moved since the
 * update before it, or a baseline for the first one, drawn from the snapshots
 * the server stored when it was posted. An initiative update shows the lines
 * the server diffed for it, and none on a first update. Its author can hide
 * the report for everyone, and updates from before snapshots show none.
 *
 * The card carries the element id `update-<id>`, so a link from an email, a
 * webhook or the inbox that ends in that hash scrolls straight to it.
 */

import React, { useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import {
  LuCopy,
  LuEllipsis,
  LuMessageSquare,
  LuPencil,
  LuTrash2,
} from 'react-icons/lu';
import {
  addProjectUpdateReaction,
  removeProjectUpdateReaction,
} from '../../api/projectUpdateThreads';
import { errorMessage } from '../../lib/errors';
import { personLabel, type Assignable } from '../../lib/issuePeople';
import { PROJECT_HEALTH_LABELS } from '../../lib/projectLook';
import { updateReport } from '../../lib/projectUpdateDiff';
import { projectUpdatesKey } from '../../lib/queryKeys';
import { replyCountLabel } from '../../lib/threadResolution';
import { showErrorToast, showToast } from '../../lib/toast';
import { toggleReactionGroup } from '../../lib/updateThreads';
import type {
  InitiativeUpdateRead,
  ProjectHealth,
  ProjectUpdateEdit,
  ProjectUpdateRead,
  ReactionGroup,
  StatusUpdateRead,
} from '../../types/Api';
import ReactionGroups from '../discussion/ReactionGroups';
import Avatar from '../ui/avatar';
import Button, { IconButton } from '../ui/button';
import Dialog from '../ui/dialog';
import Markdown from '../ui/markdown';
import Menu, { MenuItem, MenuSeparator } from '../ui/menu';
import RelativeTime from '../ui/relative-time';
import ViaSource from '../ui/via-source';
import ProjectHealthGlyph from './ProjectHealthGlyph';
import ProjectUpdateEditor from './ProjectUpdateEditor';
import ProjectUpdateThread from './ProjectUpdateThread';

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

/** What a status update is written about. */
export type UpdateSubject = 'project' | 'initiative';

/** Props for ProjectUpdateCard. */
export interface ProjectUpdateCardProps {
  update: StatusUpdateRead;
  people: Assignable[];
  /** What the update is about, named in the delete confirmation. */
  subject?: UpdateSubject;
  onEdit: (updateId: string, body: ProjectUpdateEdit) => Promise<unknown>;
  onDelete: (updateId: string) => Promise<unknown>;
}

/** The author id prefix of an update imported from Linear whose author is not a member. */
const LINEAR_AUTHOR_PREFIX = 'linear:';

/** Whether an update is a project's, which is what carries a thread. */
const isProjectUpdate = (
  update: StatusUpdateRead
): update is ProjectUpdateRead =>
  typeof (update as Partial<ProjectUpdateRead>).project_id === 'string';

/** The report lines of an update and whether it has a report to hide at all. */
const reportOf = (
  update: StatusUpdateRead,
  people: Assignable[]
): { lines: string[]; hasReport: boolean } => {
  if (!isProjectUpdate(update)) {
    const initiativeUpdate = update as Partial<InitiativeUpdateRead>;
    return {
      lines: initiativeUpdate.report ?? [],
      hasReport: (initiativeUpdate.snapshot ?? null) !== null,
    };
  }
  return {
    lines: updateReport(update, (userId) => {
      const person = people.find((each) => each.user_id === userId);
      return person === undefined ? undefined : personLabel(person);
    }),
    hasReport: (update.snapshot ?? null) !== null,
  };
};

/** Props for ProgressReport: the lines of one update's report. */
interface ProgressReportProps {
  lines: string[];
}

/** An update's progress report as a compact list under its text. */
const ProgressReport: React.FC<ProgressReportProps> = ({ lines }) => (
  <ul
    aria-label="Progress report"
    className="mt-2 space-y-0.5 border-l-2 border-line pl-3 text-xs text-text-muted"
  >
    {lines.map((line) => (
      <li key={line}>{line}</li>
    ))}
  </ul>
);

/** Props for UpdateThreadFooter. */
interface UpdateThreadFooterProps {
  update: ProjectUpdateRead;
  people: Assignable[];
}

/** A project update's reaction bar and reply toggle, and its thread when open. */
const UpdateThreadFooter: React.FC<UpdateThreadFooterProps> = ({
  update,
  people,
}) => {
  const [open, setOpen] = useState(false);
  const [toggled, setToggled] = useState<{
    base: ReactionGroup[] | undefined;
    groups: ReactionGroup[];
  } | null>(null);
  const [reactionError, setReactionError] = useState<unknown>(null);
  const { workspace_id: workspaceId, project_id: projectId } = update;
  const reactions =
    toggled !== null && toggled.base === update.reactions
      ? toggled.groups
      : (update.reactions ?? []);

  const toggle = async (emoji: string, reacted: boolean): Promise<void> => {
    setReactionError(null);
    setToggled({
      base: update.reactions,
      groups: toggleReactionGroup(reactions, emoji, reacted),
    });
    try {
      if (reacted) {
        await removeProjectUpdateReaction(
          workspaceId,
          projectId,
          update.update_id,
          { emoji }
        );
      } else {
        await addProjectUpdateReaction(
          workspaceId,
          projectId,
          update.update_id,
          { emoji }
        );
      }
    } catch (failure: unknown) {
      setToggled(null);
      setReactionError(failure);
    } finally {
      invalidateQueries([projectUpdatesKey(workspaceId, projectId)]);
    }
  };

  const count = update.comment_count ?? 0;
  const label = replyCountLabel(count) || 'Reply';

  return (
    <div className="mt-2 space-y-3 pl-7">
      <div className="flex flex-wrap items-center gap-1">
        <ReactionGroups
          reactions={reactions}
          canReact
          onToggle={toggle}
          error={reactionError}
        />
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen((was) => !was);
          }}
          className="inline-flex h-6 items-center gap-1 rounded-full px-2 text-xs text-text-muted transition-colors duration-100 hover:bg-raised hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
        >
          <LuMessageSquare aria-hidden="true" className="h-3.5 w-3.5" />
          {open && count > 0 ? 'Hide replies' : label}
        </button>
      </div>
      {open && (
        <ProjectUpdateThread
          workspaceId={workspaceId}
          projectId={projectId}
          updateId={update.update_id}
          people={people}
          autoFocus={count === 0}
        />
      )}
    </div>
  );
};

/** One update, with edit and delete for the people allowed to. */
export const ProjectUpdateCard: React.FC<ProjectUpdateCardProps> = ({
  update,
  people,
  subject = 'project',
  onEdit,
  onDelete,
}) => {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const author = update.author_id.startsWith(LINEAR_AUTHOR_PREFIX)
    ? `${update.author_id.slice(LINEAR_AUTHOR_PREFIX.length)} (Linear)`
    : personLabel(people.find((person) => person.user_id === update.author_id));

  const { lines: report, hasReport } = reportOf(update, people);

  const save = (
    body: string,
    health: ProjectHealth,
    hideDetails: boolean
  ): Promise<boolean> =>
    onEdit(
      update.update_id,
      hasReport ? { body, health, hide_details: hideDetails } : { body, health }
    ).then(
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
        <div className="ml-auto flex items-center opacity-0 transition-opacity duration-100 group-focus-within/update:opacity-100 group-hover/update:opacity-100 pointer-coarse:opacity-100">
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
            withDetailsToggle={hasReport}
            initialHideDetails={update.hide_details === true}
            onSubmit={save}
            onCancel={() => {
              setEditing(false);
            }}
          />
        ) : (
          <>
            <Markdown source={update.body} density="compact" />
            {report.length > 0 && <ProgressReport lines={report} />}
          </>
        )}
      </div>

      {isProjectUpdate(update) && (
        <UpdateThreadFooter update={update} people={people} />
      )}

      {confirming && (
        <Dialog
          open
          size="sm"
          title="Delete this update"
          description={`It is removed from the ${subject} for everyone.`}
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
