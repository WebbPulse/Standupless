/**
 * The Drafts list in the create dialog's header: every new issue the person
 * started and did not file, newest first, each with its title, team and when
 * it was last saved. Opening one resumes it in the dialog and deleting one
 * throws it away, so a run of half written issues can be picked up in any
 * order and on any device.
 */

import React from 'react';
import { LuFileText, LuTrash2 } from 'react-icons/lu';
import type { SavedIssueDraft } from '../../lib/issueDraft';
import type { TeamRead } from '../../types/Api';
import { IconButton } from '../ui/button';
import { Popover } from '../ui/popover';
import { RelativeTime } from '../ui/relative-time';
import { cn } from '../../lib/cn';

/** Props for IssueDraftsMenu: the drafts, the teams naming them and what a row does. */
export interface IssueDraftsMenuProps {
  drafts: SavedIssueDraft[];
  teams: TeamRead[] | null | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResume: (saved: SavedIssueDraft) => void;
  onDelete: (saved: SavedIssueDraft) => void;
}

/** The words a draft row leads with. */
const draftTitle = (saved: SavedIssueDraft): string =>
  saved.draft.title.trim() === '' ? 'Untitled' : saved.draft.title;

/** The "Drafts (n)" chip and the list it opens. */
export const IssueDraftsMenu: React.FC<IssueDraftsMenuProps> = ({
  drafts,
  teams,
  open,
  onOpenChange,
  onResume,
  onDelete,
}) => (
  <Popover
    label="Drafts"
    align="end"
    open={open}
    onOpenChange={onOpenChange}
    contentClassName="w-80"
    trigger={(trigger) => (
      <button
        type="button"
        {...trigger}
        className="inline-flex h-6 items-center gap-1.5 rounded-sm border border-line px-2 text-xs whitespace-nowrap text-text-muted hover:border-line-strong hover:bg-raised"
      >
        <LuFileText aria-hidden="true" className="h-3 w-3" />
        {`Drafts (${String(drafts.length)})`}
      </button>
    )}
  >
    {drafts.length === 0 ? (
      <p className="px-3 py-2 text-sm text-text-muted">No saved drafts</p>
    ) : (
      <ul aria-label="Saved drafts" className="max-h-80 overflow-y-auto py-1">
        {drafts.map((saved) => {
          const team =
            teams?.find((item) => item.id === saved.draft.teamId)?.name ??
            'Team';
          return (
            <li key={saved.id} className="group flex items-center gap-1 px-1">
              <button
                type="button"
                aria-label={`Open draft ${draftTitle(saved)}`}
                onClick={() => {
                  onResume(saved);
                }}
                className="flex min-w-0 flex-1 flex-col items-start rounded-sm px-2 py-1.5 text-left hover:bg-raised"
              >
                <span
                  className={cn(
                    'w-full truncate text-sm',
                    saved.draft.title.trim() === ''
                      ? 'text-text-muted'
                      : 'text-text'
                  )}
                >
                  {draftTitle(saved)}
                </span>
                <span className="flex w-full min-w-0 items-center gap-1.5 text-xs text-text-faint">
                  <span className="truncate">{team}</span>
                  <span aria-hidden="true">·</span>
                  <RelativeTime value={saved.updatedAt} />
                </span>
              </button>
              <IconButton
                label={`Delete draft ${draftTitle(saved)}`}
                size="sm"
                onClick={() => {
                  onDelete(saved);
                }}
              >
                <LuTrash2 className="h-3.5 w-3.5" />
              </IconButton>
            </li>
          );
        })}
      </ul>
    )}
  </Popover>
);

export default IssueDraftsMenu;
