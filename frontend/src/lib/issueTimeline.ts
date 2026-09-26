/**
 * The issue timeline: activity entries and comment threads merged into one
 * list, oldest first, so the composer at the bottom follows the newest thing
 * that happened. A run of the same kind of entry by the same actor, such as a
 * push naming the issue in several commits, collapses into one row the reader
 * can expand.
 */

import type { ActivityRead, CommentRead } from '../types/Api';
import {
  describeActivity,
  type ActivityContext,
  type ActivityDescription,
  type ActivityGroupKind,
} from './activityDisplay';

/** One activity entry with the sentence it reads as. */
export interface TimelineEvent {
  type: 'event';
  id: string;
  at: string;
  entry: ActivityRead;
  description: ActivityDescription;
}

/** A run of entries collapsed into one row. */
export interface TimelineGroup {
  type: 'group';
  id: string;
  at: string;
  group: ActivityGroupKind;
  events: TimelineEvent[];
}

/** A root comment with the replies hanging off it. */
export interface TimelineThread {
  type: 'thread';
  id: string;
  at: string;
  comment: CommentRead;
  replies: CommentRead[];
}

/** Anything the timeline renders a row for. */
export type TimelineItem = TimelineEvent | TimelineGroup | TimelineThread;

/**
 * Groups comments into roots and the replies under each. A reply whose root is
 * not loaded stands as its own thread rather than disappearing.
 */
export const commentThreads = (comments: CommentRead[]): TimelineThread[] => {
  const ids = new Set(comments.map((row) => row.comment_id));
  const roots = comments.filter(
    (row) => row.parent_comment_id === null || !ids.has(row.parent_comment_id)
  );
  return roots.map((root) => ({
    type: 'thread',
    id: root.comment_id,
    at: root.created_at,
    comment: root,
    replies: comments
      .filter((row) => row.parent_comment_id === root.comment_id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at)),
  }));
};

/** Whether two events were made by the same actor. */
const sameActor = (a: TimelineEvent, b: TimelineEvent): boolean =>
  a.entry.actor_kind === b.entry.actor_kind &&
  a.entry.actor_id === b.entry.actor_id;

/**
 * Collapses runs of two or more events that share an actor and a group kind,
 * leaving every other item where it was.
 */
export const collapseRuns = (items: TimelineItem[]): TimelineItem[] => {
  const out: TimelineItem[] = [];
  let run: TimelineEvent[] = [];

  const flush = (): void => {
    const head = run[0];
    if (head === undefined) return;
    if (run.length === 1 || head.description.group === null) {
      out.push(...run);
    } else {
      out.push({
        type: 'group',
        id: `group-${head.id}`,
        at: head.at,
        group: head.description.group,
        events: run,
      });
    }
    run = [];
  };

  for (const item of items) {
    const head = run[0];
    if (
      item.type === 'event' &&
      item.description.group !== null &&
      head !== undefined &&
      head.description.group === item.description.group &&
      sameActor(head, item)
    ) {
      run.push(item);
      continue;
    }
    flush();
    if (item.type === 'event' && item.description.group !== null) {
      run = [item];
    } else {
      out.push(item);
    }
  }
  flush();
  return out;
};

/** Orders by time, then by id, so two rows in the same second never swap. */
const byTime = (a: TimelineItem, b: TimelineItem): number =>
  a.at === b.at ? a.id.localeCompare(b.id) : a.at.localeCompare(b.at);

/** Builds the merged timeline, oldest first, with runs collapsed. */
export const buildTimeline = (
  activity: ActivityRead[],
  comments: CommentRead[],
  context: ActivityContext
): TimelineItem[] => {
  const events: TimelineEvent[] = activity.map((entry) => ({
    type: 'event',
    id: entry.activity_id,
    at: entry.created_at,
    entry,
    description: describeActivity(entry, context),
  }));
  const merged: TimelineItem[] = [...events, ...commentThreads(comments)].sort(
    byTime
  );
  return collapseRuns(merged);
};

/** Every attachment id the loaded comments show inline. */
export const commentAttachmentIds = (comments: CommentRead[]): Set<string> =>
  new Set(
    comments.flatMap((row) =>
      (row.attachments ?? []).map((item) => item.attachment_id)
    )
  );
