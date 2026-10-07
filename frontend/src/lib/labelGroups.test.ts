/**
 * The label group helpers: sections lay groups out under the loose labels,
 * picking a label of a group swaps out its sibling, and a bulk add names the
 * siblings it replaces.
 */

import { describe, expect, it } from 'vitest';
import type { LabelRead } from '../types/Api';
import {
  labelPath,
  labelSections,
  pickableLabels,
  replacedSiblings,
  toggleLabel,
  withGroupNames,
} from './labelGroups';

const area: LabelRead = {
  id: 'area',
  name: 'Area',
  color: '#000',
  is_group: true,
};
const web: LabelRead = {
  id: 'web',
  name: 'Web',
  color: '#000',
  parent_id: 'area',
};
const api: LabelRead = {
  id: 'api',
  name: 'API',
  color: '#000',
  parent_id: 'area',
};
const bug: LabelRead = { id: 'bug', name: 'Bug', color: '#000' };
const labels = [area, web, api, bug];

describe('label groups', () => {
  it('lays loose labels first and each group with its labels', () => {
    expect(
      labelSections(labels).map((section) => [
        section.group?.id,
        section.labels.map((label) => label.id),
      ])
    ).toEqual([
      [undefined, ['bug']],
      ['area', ['web', 'api']],
    ]);
  });

  it('leaves groups out of the pickable labels', () => {
    expect(pickableLabels(labels).map((label) => label.id)).toEqual([
      'web',
      'api',
      'bug',
    ]);
  });

  it('names a grouped label by its path', () => {
    expect(labelPath(web, labels)).toBe('Area/Web');
    expect(labelPath(bug, labels)).toBe('Bug');
  });

  it('swaps the sibling when a grouped label is picked', () => {
    expect(toggleLabel(labels, ['web', 'bug'], 'api')).toEqual(['bug', 'api']);
    expect(toggleLabel(labels, ['web'], 'bug')).toEqual(['web', 'bug']);
    expect(toggleLabel(labels, ['web', 'bug'], 'web')).toEqual(['bug']);
  });

  it('names the siblings a bulk add replaces', () => {
    expect(replacedSiblings(labels, ['web', 'bug'], ['api'])).toEqual(['web']);
    expect(replacedSiblings(labels, ['web'], ['bug'])).toEqual([]);
  });

  it('carries the group name for merged lists', () => {
    expect(withGroupNames(labels).find((label) => label.id === 'web')).toEqual({
      ...web,
      group_name: 'Area',
    });
  });
});
