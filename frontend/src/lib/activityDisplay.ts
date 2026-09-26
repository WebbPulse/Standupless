/**
 * How one activity entry reads in the issue timeline. Entries carry ids, so
 * the page hands in the lists it already holds (statuses, people, labels and
 * the issues it knows by key) and each entry resolves to a sentence a person
 * would write, such as "moved from Todo to In Progress", rather than naming the
 * field that changed.
 *
 * Kept apart from the component so the wording is tested without rendering,
 * and so an entry whose kind or field arrives after this build still reads as
 * plain words rather than snake case.
 */

import type { ActivityRead, IssuePriority, StatusCategory } from '../types/Api';
import { PRIORITY_LABELS, humanizeName } from './issueDisplay';
import { personLabel, type Assignable } from './issuePeople';

/** The glyph family an entry is drawn with. */
export type ActivityIcon =
  | 'created'
  | 'status'
  | 'assignee'
  | 'priority'
  | 'labels'
  | 'title'
  | 'description'
  | 'estimate'
  | 'date'
  | 'parent'
  | 'cycle'
  | 'project'
  | 'commit'
  | 'relation'
  | 'child'
  | 'other';

/** A commit a push linked to the issue. */
export interface CommitReference {
  sha: string;
  url: string;
  repository: string;
  message: string;
}

/**
 * One piece of an entry's sentence: plain words, or something the entry acted
 * on, which the view names and links (a status with its glyph, a project, a
 * cycle, an issue or a person) the way a person would point at it.
 */
export type ActivityPart =
  | { type: 'text'; value: string }
  | { type: 'status'; id: string; name: string; category: StatusCategory }
  | {
      type: 'entity';
      kind: 'project' | 'cycle' | 'issue' | 'person' | 'label';
      id: string;
      name: string;
    };

/** What an entry resolves to. */
export interface ActivityDescription {
  icon: ActivityIcon;
  /** The sentence after the actor's name, such as "moved from Todo to Done". */
  text: string;
  /** The same sentence in pieces, so the view can link what it names. */
  parts: ActivityPart[];
  /** The commit, for an entry that linked one, so the view can link the sha. */
  commit?: CommitReference;
  /**
   * Entries by the same actor with the same group collapse into one row, such
   * as "linked 3 commits". Null for entries that always stand alone.
   */
  group: ActivityGroupKind | null;
}

/** The kinds of entry that collapse when they run together. */
export type ActivityGroupKind = 'commit' | 'relation';

/** The lists an entry's ids resolve against. */
export interface ActivityContext {
  statuses: { id: string; name: string; category: StatusCategory }[];
  people: Assignable[];
  labels: { id: string; name: string }[];
  /** Issues the page knows the key of, such as the parent and link targets. */
  issues: { id: string; key: string }[];
  projects: { id: string; name: string }[];
  cycles: { id: string; name: string }[];
}

/** How a sha reads beside the sentence: the first seven characters. */
export const shortSha = (sha: string): string => sha.slice(0, 7);

/** The value as a non-empty string, or null. */
const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/** The value as a list of strings, dropping anything else. */
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];

/** Joins names the way a sentence lists them: "A", "A and B", "A, B and C". */
const listed = (names: string[]): string => {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
};

/** A commit reference from a stored value, or null for the older string form. */
export const commitReference = (value: unknown): CommitReference | null => {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const sha = text(record['sha']);
  if (sha === null) return null;
  return {
    sha,
    url: text(record['url']) ?? '',
    repository: text(record['repository']) ?? '',
    message: text(record['message']) ?? '',
  };
};

/** How a stored date reads: `2026-10-01` as "Oct 1, 2026". */
const dateText = (value: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return value;
  const parsed = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  );
  return parsed.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
};

/** How a relation type reads as a verb phrase about this issue. */
const RELATION_PHRASES: Record<string, string> = {
  blocks: 'marked this as blocking',
  blocked_by: 'marked this as blocked by',
  relates_to: 'marked this as related to',
  duplicate_of: 'marked this as a duplicate of',
  duplicated_by: 'marked this as duplicated by',
};

/** A piece of the sentence: plain words, or a named thing. */
type Piece = string | ActivityPart | null;

/** The plain words of a part, for the text form of the sentence. */
const partText = (part: ActivityPart): string =>
  part.type === 'text' ? part.value : part.name;

/** Builds a description from its pieces, spacing them as words. */
const describe = (
  icon: ActivityIcon,
  pieces: Piece[],
  group: ActivityGroupKind | null = null
): ActivityDescription => {
  const parts: ActivityPart[] = [];
  for (const piece of pieces) {
    if (piece === null || piece === '') continue;
    const part: ActivityPart =
      typeof piece === 'string' ? { type: 'text', value: piece } : piece;
    if (parts.length > 0) parts.push({ type: 'text', value: ' ' });
    parts.push(part);
  }
  return { icon, text: parts.map(partText).join(''), parts, group };
};

/** A named entity, or null when its id no longer resolves. */
const entity = (
  kind: 'project' | 'cycle' | 'issue' | 'person' | 'label',
  id: unknown,
  rows: { id: string; name: string }[]
): ActivityPart | null => {
  const found = rows.find((row) => row.id === id);
  return found === undefined
    ? null
    : { type: 'entity', kind, id: found.id, name: found.name };
};

/** The issue an id names, as a linked key, or null. */
const issueEntity = (
  id: unknown,
  context: ActivityContext
): ActivityPart | null =>
  entity(
    'issue',
    id,
    context.issues.map((issue) => ({ id: issue.id, name: issue.key }))
  );

/**
 * The issue a relation or sub-issue entry names, as its linked key and title.
 * Newer entries carry the issue whole, `{id, key, title}`, so they still read
 * after the link is gone; older ones carry the bare id and resolve against the
 * issues the page knows, with no title.
 */
const issueReference = (value: unknown, context: ActivityContext): Piece[] => {
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const id = text(record['id']);
    const key = text(record['key']);
    const title = text(record['title']);
    const known = issueEntity(id, context);
    const named: ActivityPart | null =
      id !== null && key !== null
        ? { type: 'entity', kind: 'issue', id, name: key }
        : known;
    return named === null ? [title ?? 'an issue'] : [named, title];
  }
  const known = issueEntity(value, context);
  return [known ?? 'an issue'];
};

/** How a removed relation type reads as a verb phrase about this issue. */
const REMOVED_RELATION_PHRASES: Record<string, string> = {
  blocks: 'removed blocking',
  blocked_by: 'removed blocked by',
  relates_to: 'removed related to',
  duplicate_of: 'removed duplicate of',
  duplicated_by: 'removed duplicated by',
};

/** The person an id names, falling back to "someone". */
const personEntity = (id: unknown, context: ActivityContext): ActivityPart => {
  const found = context.people.find((row) => row.user_id === id);
  return found === undefined
    ? { type: 'text', value: 'someone' }
    : {
        type: 'entity',
        kind: 'person',
        id: found.user_id,
        name: personLabel(found),
      };
};

/** Describes a change to one field. */
const describeField = (
  entry: ActivityRead,
  context: ActivityContext
): ActivityDescription => {
  const field = entry.field ?? '';
  const from = entry.from;
  const to = entry.to;

  switch (field) {
    case 'status_id': {
      const status = (id: unknown): ActivityPart | null => {
        const found = context.statuses.find((row) => row.id === id);
        return found === undefined
          ? null
          : {
              type: 'status',
              id: found.id,
              name: found.name,
              category: found.category,
            };
      };
      const before = status(from);
      const after = status(to);
      if (after === null) return describe('status', ['changed the status']);
      if (before === null)
        return describe('status', ['set the status to', after]);
      return describe('status', [
        'changed the status from',
        before,
        'to',
        after,
      ]);
    }
    case 'assignee_id': {
      if (text(to) === null) {
        return text(from) === null
          ? describe('assignee', ['removed the assignee'])
          : describe('assignee', ['unassigned', personEntity(from, context)]);
      }
      if (to === entry.actor_id && entry.actor_kind === 'user') {
        return describe('assignee', ['self-assigned the issue']);
      }
      return describe('assignee', [
        'assigned the issue to',
        personEntity(to, context),
      ]);
    }
    case 'priority': {
      const label = (value: unknown): string | null =>
        typeof value === 'string' && value !== 'none'
          ? (PRIORITY_LABELS[value as IssuePriority] ?? humanizeName(value))
          : null;
      const before = label(from);
      const after = label(to);
      if (after === null) return describe('priority', ['removed the priority']);
      return describe(
        'priority',
        before === null
          ? [`set the priority to ${after}`]
          : [`changed the priority from ${before} to ${after}`]
      );
    }
    case 'label_ids': {
      const before = strings(from);
      const after = strings(to);
      const name = (id: string): string =>
        context.labels.find((label) => label.id === id)?.name ?? 'a label';
      const added = after.filter((id) => !before.includes(id)).map(name);
      const removed = before.filter((id) => !after.includes(id)).map(name);
      const plural = (names: string[]): string =>
        names.length === 1 ? 'label' : 'labels';
      if (added.length > 0 && removed.length > 0) {
        return describe('labels', [
          `added ${listed(added)} and removed ${listed(removed)}`,
        ]);
      }
      if (added.length > 0) {
        return describe('labels', [`added ${plural(added)} ${listed(added)}`]);
      }
      if (removed.length > 0) {
        return describe('labels', [
          `removed ${plural(removed)} ${listed(removed)}`,
        ]);
      }
      return describe('labels', ['changed the labels']);
    }
    case 'title': {
      const after = text(to);
      return describe('title', [
        after === null
          ? 'changed the title'
          : `changed the title to "${after}"`,
      ]);
    }
    case 'body':
      return describe('description', [
        text(to) === null
          ? 'cleared the description'
          : 'updated the description',
      ]);
    case 'estimate': {
      const after = text(to) ?? (typeof to === 'number' ? String(to) : null);
      return describe('estimate', [
        after === null
          ? 'removed the estimate'
          : `set the estimate to ${after}`,
      ]);
    }
    case 'start_date':
    case 'due_date': {
      const which = field === 'start_date' ? 'start date' : 'due date';
      const after = text(to);
      return describe('date', [
        after === null
          ? `removed the ${which}`
          : `set the ${which} to ${dateText(after)}`,
      ]);
    }
    case 'parent_id': {
      if (text(to) === null) {
        const before = issueEntity(from, context);
        return before === null
          ? describe('parent', ['removed the parent issue'])
          : describe('parent', ['removed the parent issue', before]);
      }
      const after = issueEntity(to, context);
      return after === null
        ? describe('parent', ['made this a sub-issue'])
        : describe('parent', ['made this a sub-issue of', after]);
    }
    case 'cycle_id':
    case 'project_id': {
      const kind = field === 'cycle_id' ? 'cycle' : 'project';
      const rows = kind === 'cycle' ? context.cycles : context.projects;
      const before = entity(kind, from, rows);
      const after = entity(kind, to, rows);
      if (text(to) === null) {
        return before === null
          ? describe(kind, [`removed the issue from its ${kind}`])
          : describe(kind, [`removed the issue from ${kind}`, before]);
      }
      if (after === null) {
        return describe(kind, [
          text(from) === null
            ? `added the issue to a ${kind}`
            : `moved the issue to another ${kind}`,
        ]);
      }
      return text(from) === null
        ? describe(kind, [`added the issue to ${kind}`, after])
        : describe(kind, [`moved the issue to ${kind}`, after]);
    }
    case 'github_commit': {
      const commit = commitReference(to);
      if (commit !== null) {
        return { ...describe('commit', ['linked commit'], 'commit'), commit };
      }
      const repository = text(to);
      return describe('commit', [
        repository === null
          ? 'mentioned this issue in a commit'
          : `mentioned this issue in a commit to ${repository}`,
      ]);
    }
    case '':
      return describe('other', ['changed a field']);
    default:
      return describe('other', [`changed the ${humanizeName(field)}`]);
  }
};

/** The sentence and glyph one activity entry reads as. */
export const describeActivity = (
  entry: ActivityRead,
  context: ActivityContext
): ActivityDescription => {
  switch (entry.kind) {
    case 'created':
      return describe('created', ['created the issue']);
    case 'field_changed':
      return describeField(entry, context);
    case 'link_added': {
      const phrase = RELATION_PHRASES[entry.field ?? ''] ?? 'linked this to';
      const target = issueReference(entry.to, context);
      const pieces =
        target[0] === 'an issue'
          ? [phrase, 'another issue']
          : [phrase, ...target];
      return describe('relation', pieces, 'relation');
    }
    case 'link_removed': {
      const phrase = REMOVED_RELATION_PHRASES[entry.field ?? ''];
      if (
        phrase === undefined ||
        entry.from === null ||
        typeof entry.from !== 'object'
      ) {
        return describe('relation', ['removed a relation']);
      }
      return describe('relation', [
        phrase,
        ...issueReference(entry.from, context),
      ]);
    }
    case 'child_added':
      return describe('child', [
        'added sub-issue',
        ...issueReference(entry.to, context),
      ]);
    case 'child_removed':
      return describe('child', [
        'removed sub-issue',
        ...issueReference(entry.from, context),
      ]);
    default:
      return describe('other', [humanizeName(String(entry.kind))]);
  }
};

/** How a run of collapsed entries reads, such as "linked 3 commits". */
export const groupSentence = (
  group: ActivityGroupKind,
  count: number
): string =>
  group === 'commit'
    ? `linked ${String(count)} commits`
    : `added ${String(count)} relations`;
