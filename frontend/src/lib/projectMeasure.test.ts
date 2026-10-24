/**
 * The per project measure memory. Covers that a choice reads back for its own
 * project only and that a stray stored value reads as no choice.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  PROJECT_MEASURE_STORAGE_PREFIX,
  readProjectMeasure,
  rememberProjectMeasure,
} from './projectMeasure';

beforeEach(() => {
  localStorage.clear();
});

describe('projectMeasure', () => {
  it('reads back the choice for its own project only', () => {
    rememberProjectMeasure('prj-1', 'issues');

    expect(readProjectMeasure('prj-1')).toBe('issues');
    expect(readProjectMeasure('prj-2')).toBeNull();
  });

  it('ignores a stored value that is not a measure', () => {
    localStorage.setItem(`${PROJECT_MEASURE_STORAGE_PREFIX}prj-1`, 'hours');

    expect(readProjectMeasure('prj-1')).toBeNull();
  });
});
