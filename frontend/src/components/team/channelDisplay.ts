/** Display constants shared by the team channel form and list. */

import { CHANNEL_EVENTS, type ChannelEvent } from '../../types/Api';

/** The longest label the API accepts. */
export const CHANNEL_LABEL_MAX = 80;

/** How each event reads in the form and the list. */
export const CHANNEL_EVENT_LABELS: Record<ChannelEvent, string> = {
  issue_created: 'Issue created',
  issue_status_changed: 'Status changed',
  issue_completed: 'Issue completed',
  issue_assigned: 'Issue assigned',
  comment_created: 'New comment',
  project_update_posted: 'Project update posted',
  project_update_due: 'Project update due',
};

/** A channel's events as one line, in the order the form lists them. */
export const channelEventsLabel = (events: readonly ChannelEvent[]): string =>
  events.length === CHANNEL_EVENTS.length
    ? 'All events'
    : CHANNEL_EVENTS.filter((event) => events.includes(event))
        .map((event) => CHANNEL_EVENT_LABELS[event])
        .join(', ');
