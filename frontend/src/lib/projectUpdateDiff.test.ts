/**
 * The progress report a project update card shows. Pinned: a baseline for a
 * first update, nothing for an unchanged field, progress only past two points,
 * a milestone named completed once, and no report when hidden or absent.
 */

import { describe, expect, it } from 'vitest';
import type { ProjectUpdateSnapshot } from '../types/Api';
import { reportLines, updateReport } from './projectUpdateDiff';

const snapshot = (
  fields: Partial<ProjectUpdateSnapshot> = {}
): ProjectUpdateSnapshot => ({
  measure: 'issues',
  completed: 8,
  total: 20,
  percent: 40,
  target_date: null,
  target_date_resolution: null,
  lead_id: null,
  lead_name: null,
  status: null,
  status_id: null,
  status_name: null,
  milestones: [],
  ...fields,
});

describe('reportLines', () => {
  it('reads a first update as a baseline', () => {
    expect(
      reportLines(
        snapshot({
          target_date: '2026-09-30',
          target_date_resolution: 'quarter',
          lead_id: 'u1',
          lead_name: 'Ada',
          status: 'in_progress',
          milestones: [
            { milestone_id: 'm1', name: 'Alpha', completed: 3, total: 3 },
            { milestone_id: 'm2', name: 'Beta', completed: 1, total: 4 },
          ],
        }),
        null
      )
    ).toEqual([
      'Progress 40% (8 of 20 issues)',
      'Target date Q3 2026',
      'Lead Ada',
      'Status In progress',
      'Milestone Alpha completed',
      'Milestone Beta 1 of 4',
    ]);
  });

  it('reports nothing when nothing changed', () => {
    expect(reportLines(snapshot(), snapshot())).toEqual([]);
  });

  it('names progress only once it moved by more than two points', () => {
    expect(
      reportLines(snapshot({ completed: 9, percent: 42 }), snapshot())
    ).toEqual([]);
    expect(
      reportLines(snapshot({ completed: 9, percent: 43 }), snapshot())
    ).toEqual(['Progress 40% to 43% (9 of 20 issues)']);
    expect(
      reportLines(snapshot({ total: 30, percent: 30 }), snapshot())
    ).toEqual(['Progress 40% to 30%, scope 20 to 30 issues']);
  });

  it('gives the target date, lead and status a line each', () => {
    const before = snapshot({
      target_date: '2026-11-01',
      target_date_resolution: 'month',
      lead_id: 'u1',
      lead_name: 'Ada',
      status_name: 'Planned',
    });
    const after = snapshot({
      target_date: '2026-12-01',
      target_date_resolution: 'month',
      lead_id: 'u2',
      lead_name: 'Grace',
      status_name: 'In progress',
    });
    expect(reportLines(after, before)).toEqual([
      'Target date moved from Nov 2026 to Dec 2026',
      'New lead Grace',
      'Status changed from Planned to In progress',
    ]);
    expect(reportLines(snapshot(), before)).toEqual([
      'Target date removed, was Nov 2026',
      'Lead removed',
    ]);
  });

  it('prefers the name the reader knows the lead by', () => {
    expect(
      reportLines(
        snapshot({ lead_id: 'u2', lead_name: 'Old name' }),
        snapshot(),
        (id) => (id === 'u2' ? 'Grace Hopper' : undefined)
      )
    ).toEqual(['New lead Grace Hopper']);
  });

  it('names a finished milestone once and a moved one by its counts', () => {
    const before = snapshot({
      milestones: [
        { milestone_id: 'm1', name: 'Alpha', completed: 2, total: 3 },
        { milestone_id: 'm2', name: 'Beta', completed: 1, total: 4 },
        { milestone_id: 'm3', name: 'Gamma', completed: 5, total: 5 },
      ],
    });
    const after = snapshot({
      milestones: [
        { milestone_id: 'm1', name: 'Alpha', completed: 3, total: 3 },
        { milestone_id: 'm2', name: 'Beta', completed: 2, total: 4 },
        { milestone_id: 'm3', name: 'Gamma', completed: 5, total: 5 },
        { milestone_id: 'm4', name: 'Delta', completed: 0, total: 2 },
      ],
    });
    expect(reportLines(after, before)).toEqual([
      'Milestone Alpha completed',
      'Milestone Beta 1 of 4 to 2 of 4',
      'Milestone Delta 0 of 2',
    ]);
  });
});

describe('updateReport', () => {
  it('is empty for an update from before snapshots or a hidden report', () => {
    expect(updateReport({})).toEqual([]);
    expect(updateReport({ snapshot: snapshot(), hide_details: true })).toEqual(
      []
    );
  });

  it('diffs against the previous snapshot when there is one', () => {
    expect(updateReport({ snapshot: snapshot() })).toEqual([
      'Progress 40% (8 of 20 issues)',
    ]);
    expect(
      updateReport({ snapshot: snapshot(), previous_snapshot: snapshot() })
    ).toEqual([]);
  });
});
