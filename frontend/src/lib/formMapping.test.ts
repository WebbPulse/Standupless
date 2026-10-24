/**
 * The form mapping preview: chosen options map labels and priority the way the
 * server applies them, and editing the chips keeps the hand-picked set apart.
 */

import { describe, expect, it } from 'vitest';
import type { FormFieldRead, LabelRead } from '../types/Api';
import {
  formMapping,
  pickedAfterEdit,
  previewLabels,
  previewPriority,
} from './formMapping';

const labels: LabelRead[] = [
  { id: 'kind', name: 'Kind', color: '#000', is_group: true },
  { id: 'bug', name: 'Bug', color: '#000', parent_id: 'kind' },
  { id: 'feature', name: 'Feature', color: '#000', parent_id: 'kind' },
  { id: 'ui', name: 'UI', color: '#000' },
  { id: 'crash', name: 'Crash', color: '#000' },
];

const fields: FormFieldRead[] = [
  {
    key: 'f1',
    label: 'Severity',
    type: 'select',
    required: true,
    options: [
      { value: 'Crash', label_id: 'crash', priority: 'urgent' },
      { value: 'Cosmetic', label_id: 'ui', priority: 'low' },
      { value: 'Other' },
    ],
  },
  {
    key: 'f2',
    label: 'Kind',
    type: 'select',
    required: false,
    options: [{ value: 'Bug', label_id: 'bug' }],
  },
  {
    key: 'f3',
    label: 'Notes',
    type: 'long_text',
    required: false,
    options: [],
  },
];

describe('formMapping', () => {
  it('collects the labels and last priority of the chosen options', () => {
    expect(formMapping(fields, { f1: 'Crash', f2: 'Bug', f3: 'x' })).toEqual({
      labelIds: ['crash', 'bug'],
      priority: 'urgent',
    });
  });

  it('maps nothing for an option without a label or priority', () => {
    expect(formMapping(fields, { f1: 'Other' })).toEqual({
      labelIds: [],
      priority: null,
    });
  });
});

describe('previewLabels', () => {
  it('puts mapped labels first and lets them win their group', () => {
    expect(previewLabels(labels, ['bug'], ['feature', 'ui'])).toEqual([
      'bug',
      'ui',
    ]);
  });

  it('drops labels the team does not offer once its labels load', () => {
    expect(previewLabels(labels, ['gone'], ['ui'])).toEqual(['ui']);
    expect(previewLabels([], ['gone'], ['ui'])).toEqual(['gone', 'ui']);
  });
});

describe('previewPriority', () => {
  it('prefers the mapped priority and falls back to the picked one', () => {
    expect(previewPriority({ labelIds: [], priority: 'urgent' }, 'low')).toBe(
      'urgent'
    );
    expect(previewPriority({ labelIds: [], priority: null }, 'low')).toBe(
      'low'
    );
  });
});

describe('pickedAfterEdit', () => {
  it('keeps a mapped label out of the hand-picked set', () => {
    const mapping = { labelIds: ['crash'], priority: null };
    const shown = previewLabels(labels, mapping.labelIds, ['ui']);
    expect(
      pickedAfterEdit(labels, mapping, ['ui'], shown, [...shown, 'feature'])
    ).toEqual(['ui', 'feature']);
  });

  it('keeps a hand-picked label the mapping hides until another of its group is picked', () => {
    const mapping = { labelIds: ['bug'], priority: null };
    const shown = previewLabels(labels, mapping.labelIds, ['feature']);
    expect(shown).toEqual(['bug']);
    expect(
      pickedAfterEdit(labels, mapping, ['feature'], shown, [...shown, 'ui'])
    ).toEqual(['ui', 'feature']);
  });

  it('restores the hand-picked labels when the answer changes', () => {
    const picked = ['feature', 'ui'];
    const before = previewLabels(labels, ['bug'], picked);
    const after = previewLabels(labels, [], picked);
    expect(before).toEqual(['bug', 'ui']);
    expect(after).toEqual(['feature', 'ui']);
  });
});
