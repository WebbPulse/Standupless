import { describe, expect, it } from 'vitest';
import { BRANCH_MAX, gitBranchName } from './gitBranch';

describe('gitBranchName', () => {
  it('joins the lowercased key and a slug of the title', () => {
    expect(gitBranchName('GHS-1', 'Fix login')).toBe('ghs-1-fix-login');
  });

  it('drops punctuation and accents', () => {
    expect(gitBranchName('ENG-12', "Don't crash on résumé upload!")).toBe(
      'eng-12-don-t-crash-on-resume-upload'
    );
  });

  it('falls back to the key when the title has no letters', () => {
    expect(gitBranchName('ENG-3', '!!!')).toBe('eng-3');
  });

  it('caps the length without a trailing hyphen', () => {
    const name = gitBranchName('ENG-4', 'word '.repeat(40));
    expect(name.length).toBeLessThanOrEqual(BRANCH_MAX);
    expect(name.endsWith('-')).toBe(false);
    expect(name.startsWith('eng-4-word')).toBe(true);
  });
});
