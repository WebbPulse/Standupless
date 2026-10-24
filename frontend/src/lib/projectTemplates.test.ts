/**
 * What a project template fills in the new project dialog: only the fields it
 * sets, its offsets as dates counted from today, the hint naming what it adds,
 * and the next free key for a new row.
 */

import { describe, expect, it } from 'vitest';
import type { ProjectBlueprint, TemplateRead } from '../types/Api';
import {
  nextTemplateKey,
  offsetDate,
  projectTemplateHint,
  projectTemplatePrefill,
} from './projectTemplates';

const blueprint = (fields: Partial<ProjectBlueprint>): ProjectBlueprint => ({
  member_ids: [],
  milestones: [],
  issues: [],
  ...fields,
});

/** A saved project template carrying the blueprint given. */
const template = (project: ProjectBlueprint | null): TemplateRead => ({
  id: 'tp-1',
  name: 'Launch',
  team_id: 't-1',
  scope: 'team',
  kind: 'project',
  project,
  title: null,
  body: null,
  status_id: null,
  priority: null,
  assignee_id: null,
  label_ids: [],
  estimate: null,
  project_id: null,
  project_milestone_id: null,
  cycle_id: null,
  position: 0,
  created_by: 'user-1',
  created_at: '2026-10-10T00:00:00Z',
  updated_at: '2026-10-10T00:00:00Z',
});

const TODAY = new Date(2026, 9, 30);

describe('offsetDate', () => {
  it('counts calendar days across a month end', () => {
    expect(offsetDate(0, TODAY)).toBe('2026-10-30');
    expect(offsetDate(3, TODAY)).toBe('2026-11-02');
  });
});

describe('projectTemplatePrefill', () => {
  it('fills only the fields the template sets', () => {
    const fill = projectTemplatePrefill(
      template(
        blueprint({
          description: 'Ship it',
          status: 'in_progress',
          priority: 'high',
          lead_id: 'u-1',
          member_ids: ['u-2'],
          start_offset_days: 0,
          target_offset_days: 14,
        })
      ),
      TODAY
    );
    expect(fill).toEqual({
      description: 'Ship it',
      status: 'in_progress',
      priority: 'high',
      leadId: 'u-1',
      memberIds: ['u-2'],
      startDate: '2026-10-30',
      targetDate: '2026-11-13',
    });
  });

  it('fills nothing from an empty or missing blueprint', () => {
    expect(projectTemplatePrefill(template(blueprint({})), TODAY)).toEqual({});
    expect(projectTemplatePrefill(template(null), TODAY)).toEqual({});
  });
});

describe('projectTemplateHint', () => {
  it('names the milestones and issues a template adds', () => {
    expect(
      projectTemplateHint(
        blueprint({
          milestones: [
            { key: 'm1', name: 'Alpha' },
            { key: 'm2', name: 'Beta' },
            { key: 'm3', name: 'GA' },
          ],
          issues: [{ key: 'i1', title: 'Write the plan' }],
        })
      )
    ).toBe('Adds 3 milestones and 1 issue');
  });

  it('answers null when a template adds nothing', () => {
    expect(projectTemplateHint(blueprint({}))).toBeNull();
    expect(projectTemplateHint(null)).toBeNull();
  });
});

describe('nextTemplateKey', () => {
  it('takes the first number not in use', () => {
    expect(nextTemplateKey('m', [])).toBe('m1');
    expect(nextTemplateKey('i', ['i1', 'i3'])).toBe('i2');
  });
});
