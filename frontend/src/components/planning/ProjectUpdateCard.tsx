/**
 * One project update in the feed: who wrote it, when, the health they called,
 * and the text as Markdown. The author and a workspace admin edit it in place
 * or delete it from a menu, which is what the server's `can_edit` says.
 *
 * Every update also carries its thread, as Linear's do: a reaction bar with
 * counts, the reader's own reactions pressed, and a reply toggle naming how
 * many replies there are, which opens the replies and a reply box under the
 * update. A project update's thread and an initiative update's run on the
 * same component, each under its own parent's routes.
 *
 * Under a project update's text sits its progress report: what moved since the
 * update before it, or a baseline for the first one, drawn from the snapshots
 * the server stored when it was posted. An initiative update shows the lines
 * the server diffed for it, and none on a first update. Its author can hide
 * the report for everyone, and updates from before snapshots show none.
 *
 * The card carries the element id `update-<id>`, so a link from an email, a
 * webhook or the inbox that ends in that hash scrolls straight to it. Its menu
 * copies that link, or the update itself as Markdown: the author, the date and
 * the health on one line, then the text.
 */

import React, { useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import {
  LuCopy,
  LuEllipsis,
  LuFileText,
  LuMessageSquare,
  LuPencil,
  LuTrash2,
} from 'react-icons/lu';
import {
  addProjectUpdateReaction,
  removeProjectUpdateReaction,
  type UpdateParent,
} from '../../api/projectUpdateThreads';
import { copyText } from '../../lib/copyIssue';
import { errorMessage } from '../../lib/errors';
import { personLabel, type Assignable } from '../../lib/issuePeople';
import { PROJECT_HEALTH_LABELS } from '../../lib/projectLook';
import { updateReport } from '../../lib/projectUpdateDiff';
import { statusUpdatesKey } from '../../lib/queryKeys';
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

/**
 * An update as Markdown: the author in bold, the day it was posted and the
 * health it called on one line, then its text as stored. The same update
 * always gives the same text.
 */
export const updateMarkdown = (
  update: Pick<StatusUpdateRead, 'body' | 'health' | 'created_at'>,
  author: string
): string => {
  const header = [
    `**${author}**`,
    update.created_at.slice(0, 10),
    PROJECT_HEALTH_LABELS[update.health],
  ].join(' · ');
  const body = update.body.replace(/\s+$/, '');
  return `${body === '' ? header : `${header}\n\n${body}`}\n`;
};

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

/** Whether an update is a project's rather than an initiative's. */
const isProjectUpdate = (
  update: StatusUpdateRead
): update is ProjectUpdateRead =>
  typeof (update as Partial<ProjectUpdateRead>).project_id === 'string';

/** The project or initiative an update is about, which its thread's routes sit under. */
const parentOf = (update: StatusUpdateRead): UpdateParent =>
  isProjectUpdate(update)
    ? { kind: 'project', id: update.project_id }
    : {
        kind: 'initiative',
        id: (update as Partial<InitiativeUpdateRead>).initiative_id ?? '',
      };

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
  update: StatusUpdateRead;
  parent: UpdateParent;
  people: Assignable[];
}

/** An update's reaction bar and reply toggle, and its thread when open. */
const UpdateThreadFooter: React.FC<UpdateThreadFooterProps> = ({
  update,
  parent,
  people,
}) => {
  const [open, setOpen] = useState(false);
  const [toggled, setToggled] = useState<{
    base: ReactionGroup[] | undefined;
    groups: ReactionGroup[];
  } | null>(null);
  const [reactionError, setReactionError] = useState<unknown>(null);
  const { workspace_id: workspaceId } = update;
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
          parent,
          update.update_id,
          { emoji }
        );
      } else {
        await addProjectUpdateReaction(workspaceId, parent, update.update_id, {
          emoji,
        });
      }
    } catch (failure: unknown) {
      setToggled(null);
      setReactionError(failure);
    } finally {
      invalidateQueries([
        statusUpdatesKey(workspaceId, parent.kind, parent.id),
      ]);
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
          parent={parent}
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
  const parent = parentOf(update);

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
    copyText(url.toString(), 'Link to the update copied');
  };

  const copyMarkdown = (): void => {
    copyText(updateMarkdown(update, author), 'Update copied as Markdown');
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
            <MenuItem onSelect={copyMarkdown}>
              <LuFileText aria-hidden="true" className="h-3.5 w-3.5" />
              Copy as Markdown
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

      {parent.id !== '' && (
        <UpdateThreadFooter update={update} parent={parent} people={people} />
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
