/**
 * The wording the issue views share. Pinned so a rename in one view cannot
 * silently disagree with another, and so the activity feed keeps rendering an
 * entry whose kind or field the contract adds later.
 */

import { describe, expect, it } from 'vitest';
import {
  LINK_TYPES,
  PRIORITIES,
  PRIORITY_LABELS,
  SORTS,
  SORT_LABELS,
  activitySentence,
  dateLabel,
  linkTypeLabel,
  progressPercent,
  timestampLabel,
} from './issueDisplay';
import type { ActivityRead } from '../types/Api';

/** One activity entry, which each case varies from. */
const entry = (over: Partial<ActivityRead>): ActivityRead => ({
  activity_id: 'act-1',
  issue_id: 'iss-1',
  actor_id: 'user-1',
  actor_kind: 'user',
  kind: 'created',
  field: null,
  from: null,
  to: null,
  created_at: '2026-09-17T00:00:00Z',
  ...over,
});

describe('the fixed vocabularies', () => {
  it('names every priority the contract fixes', () => {
    expect(PRIORITIES).toEqual(['none', 'urgent', 'high', 'medium', 'low']);
    for (const priority of PRIORITIES) {
      expect(PRIORITY_LABELS[priority]).toBeTruthy();
    }
  });

  it('names every sort order, with the route default first', () => {
    expect(SORTS[0]).toBe('updated_desc');
    for (const sort of SORTS) {
      expect(SORT_LABELS[sort]).toBeTruthy();
    }
  });

  it('offers only the four link types a caller may write', () => {
    expect(LINK_TYPES).toEqual([
      'blocks',
      'blocked_by',
      'relates_to',
      'duplicate_of',
    ]);
  });
});

describe('linkTypeLabel', () => {
  it('reads the inverse the server returns but never accepts on a write', () => {
    expect(linkTypeLabel('duplicated_by')).toBe('Duplicated by');
  });

  it('falls back to the raw value rather than rendering nothing', () => {
    expect(linkTypeLabel('caused_by')).toBe('caused_by');
  });
});

describe('activitySentence', () => {
  it('reads a creation', () => {
    expect(activitySentence(entry({ kind: 'created' }))).toBe(
      'created this issue'
    );
  });

  it('names the field a change touched', () => {
    expect(
      activitySentence(entry({ kind: 'field_changed', field: 'status_id' }))
    ).toBe('changed the status');
  });

  it('falls back to the raw field name for one it does not know', () => {
    expect(
      activitySentence(entry({ kind: 'field_changed', field: 'cycle_id' }))
    ).toBe('changed cycle_id');
  });

  it('reads the link and child kinds', () => {
    expect(activitySentence(entry({ kind: 'link_added' }))).toBe(
      'added a link'
    );
    expect(activitySentence(entry({ kind: 'child_removed' }))).toBe(
      'removed a sub-issue'
    );
  });
});

describe('progressPercent', () => {
  it('reads zero rather than dividing by no children', () => {
    expect(progressPercent({ total: 0, completed: 0 })).toBe(0);
  });

  it('rounds the completed share', () => {
    expect(progressPercent({ total: 3, completed: 1 })).toBe(33);
    expect(progressPercent({ total: 4, completed: 4 })).toBe(100);
  });
});

describe('the label helpers', () => {
  it('says so rather than rendering an empty cell for an unset date', () => {
    expect(dateLabel(null)).toBe('Not set');
    expect(dateLabel('2026-09-17')).toBe('2026-09-17');
  });

  it('leaves a timestamp it cannot parse exactly as it arrived', () => {
    expect(timestampLabel('not a date')).toBe('not a date');
    expect(timestampLabel('2026-09-17T00:00:00Z')).not.toBe('');
  });
});
