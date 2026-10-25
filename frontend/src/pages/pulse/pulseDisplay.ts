/**
 * How a Pulse entry reads in words and where it links, kept apart from the
 * card so the page's keyboard handling can open an entry without rendering it.
 */

import {
  initiativePath,
  projectPath,
  projectUpdatesTabPath,
} from '../../lib/paths';
import { PROJECT_HEALTH_LABELS } from '../../lib/projectLook';
import type { PulseItemRead } from '../../types/Api';

/** Where an entry links: the updates tab for an update, else the page; empty when it has nowhere. */
export const entryHref = (slug: string, item: PulseItemRead): string => {
  if (item.subject_type === 'initiative' && item.initiative_id !== null) {
    const base = initiativePath(slug, {
      initiative_id: item.initiative_id,
      name: item.initiative_name,
    });
    return item.event_type === 'initiative_update'
      ? `${base}?tab=updates`
      : base;
  }
  if (item.project_id === null) return '';
  const project = { project_id: item.project_id, name: item.project_name };
  return item.event_type === 'project_update'
    ? projectUpdatesTabPath(slug, project)
    : projectPath(slug, project);
};

/** Where the page of what an entry is about lives; empty when it has none. */
export const subjectHref = (slug: string, item: PulseItemRead): string => {
  if (item.subject_type === 'initiative') {
    return item.initiative_id === null
      ? ''
      : initiativePath(slug, {
          initiative_id: item.initiative_id,
          name: item.initiative_name,
        });
  }
  return item.project_id === null
    ? ''
    : projectPath(slug, {
        project_id: item.project_id,
        name: item.project_name,
      });
};

/** The name of what an entry is about. */
export const subjectName = (item: PulseItemRead): string =>
  (item.subject_type === 'initiative'
    ? item.initiative_name
    : item.project_name) ?? 'Untitled';

/** The words after the actor's name, saying what happened. */
export const describeEvent = (item: PulseItemRead): string => {
  switch (item.event_type) {
    case 'project_update':
    case 'initiative_update':
      return 'posted an update';
    case 'project_health':
    case 'initiative_health':
      return item.health === null
        ? 'cleared the health'
        : `set the health to ${PROJECT_HEALTH_LABELS[item.health].toLowerCase()}`;
    case 'milestone_completed':
      return `completed ${item.milestone_name ?? 'a milestone'}`;
  }
};

/** One sentence saying who did what, for the entry's label and an actorless line. */
export const summary = (item: PulseItemRead): string => {
  if (item.actor_name !== '') {
    return `${item.actor_name} ${describeEvent(item)}`;
  }
  if (item.event_type === 'milestone_completed') {
    return `${item.milestone_name ?? 'A milestone'} was completed`;
  }
  const sentence = describeEvent(item);
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
};
