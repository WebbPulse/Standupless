import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BranchFormat } from '../types/Api';
import { BRANCH_MAX, branchHandle, gitBranchName } from './gitBranch';

/** One case of the fixture the CLI's tests read too. */
interface BranchCase {
  key: string;
  title: string;
  format: BranchFormat;
  handle: string;
  expected: string;
}

const cases = JSON.parse(
  readFileSync(
    join(process.cwd(), '../cli/tests/fixtures/branch_names.json'),
    'utf8'
  )
) as BranchCase[];

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

  it('leads with the handle in the username format', () => {
    expect(
      gitBranchName('STUP-1', 'X', { format: 'user_key_title', handle: 'user' })
    ).toBe('user/stup-1-x');
  });

  it('copies the key alone in the identifier format', () => {
    expect(gitBranchName('ENG-12', 'Fix login', { format: 'key' })).toBe(
      'eng-12'
    );
  });

  it('cuts a long handle before the key', () => {
    const name = gitBranchName('STUP-497', 'Fix login', {
      format: 'user_key_title',
      handle: 'a'.repeat(80),
    });
    expect(name.length).toBeLessThanOrEqual(BRANCH_MAX);
    expect(name.endsWith('/stup-497')).toBe(true);
  });

  it.each(cases)(
    'matches the CLI for $format $key',
    ({ key, title, format, handle, expected }) => {
      expect(gitBranchName(key, title, { format, handle })).toBe(expected);
    }
  );
});

describe('branchHandle', () => {
  it('uses the username, else the email local part', () => {
    expect(branchHandle({ display_name: ' tw ', email: 't@example.com' })).toBe(
      'tw'
    );
    expect(
      branchHandle({ display_name: null, email: 'tyler@example.com' })
    ).toBe('tyler');
    expect(branchHandle(undefined)).toBe('');
  });
});
