/**
 * A project's updates tab: a composer at the top for the people who may post,
 * then every update newest first, a page at a time behind "Load more".
 *
 * The composer stays a one line prompt until it is opened, so reading the feed
 * is not crowded by an empty editor. The page opens it from outside too, for
 * the due nudge and the command palette. Once the project's update is due by
 * its cadence, a banner above the composer says so and asks for a health call
 * with the write up.
 *
 * When the address carries `#update-<id>`, the feed scrolls to that update
 * once it has loaded, which is where email, webhook and inbox links land.
 */

import React, { useEffect, useRef } from 'react';
import { LuPencilLine } from 'react-icons/lu';
import { useLocation } from 'react-router-dom';
import type { ProjectUpdates } from '../../hooks/useProjectUpdates';
import { errorMessage } from '../../lib/errors';
import type { Assignable } from '../../lib/issuePeople';
import { showErrorToast, showToast } from '../../lib/toast';
import { updateDueLabel } from '../../lib/planningDisplay';
import type { ProjectHealth, ProjectUpdateDueState } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import EmptyState from '../ui/empty-state';
import { SkeletonRows } from '../ui/skeleton';
import ProjectUpdateCard from './ProjectUpdateCard';
import ProjectUpdateEditor from './ProjectUpdateEditor';

/** Props for ProjectUpdatesFeed. */
export interface ProjectUpdatesFeedProps {
  feed: ProjectUpdates;
  people: Assignable[];
  /** Whether the reader may post an update. */
  canPost: boolean;
  /** The health a new update starts on, the project's own when it has one. */
  defaultHealth: ProjectHealth;
  composing: boolean;
  onComposingChange: (composing: boolean) => void;
  /** Where the project stands against its update cadence, or null when it never comes due. */
  dueState?: ProjectUpdateDueState | null;
  /** When the next update is due, or null. */
  dueAt?: string | null;
}

/** The composer and the list of one project's updates. */
export const ProjectUpdatesFeed: React.FC<ProjectUpdatesFeedProps> = ({
  feed,
  people,
  canPost,
  defaultHealth,
  composing,
  onComposingChange,
  dueState = null,
  dueAt = null,
}) => {
  const { hash } = useLocation();
  const scrolledTo = useRef<string | null>(null);
  const { updates, create } = feed;

  useEffect(() => {
    if (!hash.startsWith('#update-') || scrolledTo.current === hash) return;
    const target = document.getElementById(hash.slice(1));
    if (target === null) return;
    scrolledTo.current = hash;
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'start' });
    }
  }, [hash, updates]);

  const post = (body: string, health: ProjectHealth): Promise<boolean> =>
    create({ body, health }).then(
      () => {
        showToast('Update posted');
        onComposingChange(false);
        return true;
      },
      (failure: unknown) => {
        showErrorToast(errorMessage(failure, 'Could not post that update.'));
        return false;
      }
    );

  const dueLabel = updateDueLabel(dueState);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-8 lg:px-8">
      {dueLabel !== null && (
        <div
          role="status"
          className={
            dueState === 'overdue'
              ? 'rounded-md border border-line bg-danger-soft px-3 py-2 text-xs text-danger'
              : 'rounded-md border border-line bg-warning-soft px-3 py-2 text-xs text-warning'
          }
        >
          {dueLabel}
          {dueAt !== null && ` since ${dueAt.slice(0, 10)}`}
          {canPost
            ? '. Pick a health, on track, at risk or off track, and say how the project is going.'
            : '.'}
        </div>
      )}
      {canPost &&
        (composing ? (
          <ProjectUpdateEditor
            key={defaultHealth}
            people={people}
            initialHealth={defaultHealth}
            submitLabel="Post update"
            busyLabel="Posting"
            ariaLabel="Write a project update"
            autoFocus
            clearOnSubmit
            onSubmit={post}
            onCancel={() => {
              onComposingChange(false);
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              onComposingChange(true);
            }}
            className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2.5 text-left text-sm text-text-faint transition-colors duration-100 hover:border-line-strong hover:text-text-muted focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
          >
            <LuPencilLine aria-hidden="true" className="h-4 w-4" />
            Write a project update...
          </button>
        ))}

      {feed.error !== null && feed.error !== undefined && (
        <ErrorAlert
          message={errorMessage(feed.error, 'Could not load the updates.')}
        />
      )}

      {feed.isLoading && updates.length === 0 ? (
        <SkeletonRows label="Loading updates" />
      ) : updates.length === 0 ? (
        <EmptyState
          message={
            canPost
              ? 'No updates yet. Share how the project is going and whether it is on track.'
              : 'No updates yet.'
          }
        />
      ) : (
        <ol aria-label="Project updates" className="space-y-3">
          {updates.map((update) => (
            <li key={update.update_id}>
              <ProjectUpdateCard
                update={update}
                people={people}
                onEdit={feed.edit}
                onDelete={feed.remove}
              />
            </li>
          ))}
        </ol>
      )}

      {feed.hasMore && (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            size="sm"
            disabled={feed.isPaging}
            onClick={feed.loadMore}
          >
            {feed.isPaging ? 'Loading' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
};

export default ProjectUpdatesFeed;
