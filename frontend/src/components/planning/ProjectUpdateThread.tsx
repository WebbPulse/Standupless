/**
 * The replies under one project update, as Linear shows them: each reply with
 * its author, a relative time, the body as Markdown and its own reactions, and
 * a reply box at the foot on the same rich editor updates are written on, with
 * @mentions from the project's people.
 *
 * The thread is read only while it is open, so a feed of closed cards costs no
 * request per card. A reply's author or an admin edits or deletes it from its
 * menu, which is what the server's `can_edit` says.
 */

import React, { useState } from 'react';
import {
  invalidateQueries,
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { LuEllipsis, LuPencil, LuTrash2 } from 'react-icons/lu';
import {
  addProjectUpdateReaction,
  createProjectUpdateComment,
  deleteProjectUpdateComment,
  listProjectUpdateComments,
  removeProjectUpdateReaction,
  updateProjectUpdateComment,
} from '../../api/projectUpdateThreads';
import { errorMessage } from '../../lib/errors';
import { personLabel, type Assignable } from '../../lib/issuePeople';
import {
  projectUpdateCommentsKey,
  projectUpdatesKey,
} from '../../lib/queryKeys';
import { showErrorToast } from '../../lib/toast';
import type { ProjectUpdateCommentRead } from '../../types/Api';
import ReactionGroups from '../discussion/ReactionGroups';
import { ErrorAlert } from '../ui/alert';
import Avatar from '../ui/avatar';
import { IconButton } from '../ui/button';
import Markdown from '../ui/markdown';
import Menu, { MenuItem, MenuSeparator } from '../ui/menu';
import RelativeTime from '../ui/relative-time';
import { SkeletonRows } from '../ui/skeleton';
import ViaSource from '../ui/via-source';
import ProjectUpdateEditor from './ProjectUpdateEditor';

/** How often an open thread re-reads, so someone else's reply appears. */
const POLL_MS = 30000;

/** Which update a thread hangs off. */
export interface UpdateThreadTarget {
  workspaceId: string;
  projectId: string;
  updateId: string;
}

/** Props for one reply in the thread. */
interface ReplyItemProps extends UpdateThreadTarget {
  reply: ProjectUpdateCommentRead;
  people: Assignable[];
}

/** One reply: header, body, reactions, and edit or delete when allowed. */
const ReplyItem: React.FC<ReplyItemProps> = ({
  workspaceId,
  projectId,
  updateId,
  reply,
  people,
}) => {
  const [editing, setEditing] = useState(false);
  const keys = [
    projectUpdateCommentsKey(workspaceId, projectId, updateId),
    projectUpdatesKey(workspaceId, projectId),
  ];
  const author = personLabel({
    user_id: reply.author.user_id,
    email: reply.author.email,
    display_name: reply.author.display_name,
  });

  const { mutate: save } = useMutationWithRefetch(
    (body: string) =>
      updateProjectUpdateComment(
        workspaceId,
        projectId,
        updateId,
        reply.comment_id,
        body
      ),
    keys
  );

  const { mutate: remove } = useMutationWithRefetch(
    () =>
      deleteProjectUpdateComment(
        workspaceId,
        projectId,
        updateId,
        reply.comment_id
      ),
    keys
  );

  const { mutate: toggle, error: reactionError } = useMutationWithRefetch(
    async (emoji: string, reacted: boolean): Promise<void> => {
      const target = { emoji, comment_id: reply.comment_id };
      if (reacted) {
        await removeProjectUpdateReaction(
          workspaceId,
          projectId,
          updateId,
          target
        );
        return;
      }
      await addProjectUpdateReaction(workspaceId, projectId, updateId, target);
    },
    keys
  );

  const submitEdit = (body: string): Promise<boolean> =>
    save(body).then(
      () => {
        setEditing(false);
        return true;
      },
      (failure: unknown) => {
        showErrorToast(errorMessage(failure, 'Could not save that reply.'));
        return false;
      }
    );

  const deleteReply = (): void => {
    void remove().catch((failure: unknown) => {
      showErrorToast(errorMessage(failure, 'Could not delete that reply.'));
    });
  };

  return (
    <li className="group/reply flex gap-2">
      <Avatar name={author} src={reply.author.avatar_url} size="xs" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-medium text-text">
            {author}
          </span>
          <RelativeTime value={reply.created_at} />
          <ViaSource source={reply.source} />
          {reply.edited_at !== null && (
            <span className="text-xs text-text-faint">(edited)</span>
          )}
          {reply.can_edit && (
            <div className="ml-auto opacity-0 transition-opacity duration-100 group-focus-within/reply:opacity-100 group-hover/reply:opacity-100 pointer-coarse:opacity-100">
              <Menu
                label="Reply actions"
                align="end"
                trigger={(props) => (
                  <IconButton label="Reply actions" size="sm" {...props}>
                    <LuEllipsis className="h-3.5 w-3.5" />
                  </IconButton>
                )}
              >
                <MenuItem
                  onSelect={() => {
                    setEditing(true);
                  }}
                >
                  <LuPencil aria-hidden="true" className="h-3.5 w-3.5" />
                  Edit
                </MenuItem>
                <MenuSeparator />
                <MenuItem danger onSelect={deleteReply}>
                  <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
                  Delete
                </MenuItem>
              </Menu>
            </div>
          )}
        </div>
        {editing ? (
          <ProjectUpdateEditor
            people={people}
            initialBody={reply.body}
            initialHealth="on_track"
            withHealth={false}
            submitLabel="Save"
            busyLabel="Saving"
            ariaLabel="Edit reply"
            autoFocus
            onSubmit={submitEdit}
            onCancel={() => {
              setEditing(false);
            }}
          />
        ) : (
          <Markdown source={reply.body} density="compact" />
        )}
        <ReactionGroups
          reactions={reply.reactions}
          canReact
          onToggle={toggle}
          error={reactionError}
        />
      </div>
    </li>
  );
};

/** Props for ProjectUpdateThread. */
export interface ProjectUpdateThreadProps extends UpdateThreadTarget {
  people: Assignable[];
  /** Focuses the reply box as the thread opens. */
  autoFocus?: boolean;
}

/** An open update's replies, oldest first, and the box that adds one. */
export const ProjectUpdateThread: React.FC<ProjectUpdateThreadProps> = ({
  workspaceId,
  projectId,
  updateId,
  people,
  autoFocus = false,
}) => {
  const auth = useQueryAuth();
  const key = projectUpdateCommentsKey(workspaceId, projectId, updateId);

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) =>
      listProjectUpdateComments(workspaceId, projectId, updateId, signal),
    { intervalMs: POLL_MS, queryKey: key, auth }
  );
  const replies = data ?? [];

  const post = (body: string): Promise<boolean> =>
    createProjectUpdateComment(workspaceId, projectId, updateId, body).then(
      () => {
        invalidateQueries([key, projectUpdatesKey(workspaceId, projectId)]);
        return true;
      },
      (failure: unknown) => {
        showErrorToast(errorMessage(failure, 'Could not post that reply.'));
        return false;
      }
    );

  return (
    <section aria-label="Replies" className="space-y-3">
      {error !== null && error !== undefined && (
        <ErrorAlert message={errorMessage(error, 'Could not load replies.')} />
      )}
      {isLoading && replies.length === 0 ? (
        <SkeletonRows label="Loading replies" />
      ) : (
        replies.length > 0 && (
          <ol className="space-y-3">
            {replies.map((reply) => (
              <ReplyItem
                key={reply.comment_id}
                workspaceId={workspaceId}
                projectId={projectId}
                updateId={updateId}
                reply={reply}
                people={people}
              />
            ))}
          </ol>
        )
      )}
      <ProjectUpdateEditor
        people={people}
        initialHealth="on_track"
        withHealth={false}
        submitLabel="Reply"
        busyLabel="Replying"
        ariaLabel="Reply to update"
        placeholder="Leave a reply..."
        autoFocus={autoFocus}
        clearOnSubmit
        onSubmit={post}
      />
    </section>
  );
};

export default ProjectUpdateThread;
