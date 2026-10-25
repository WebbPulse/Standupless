/**
 * The key texts an issue's detail read was held under, so a notice naming the
 * issue by id also refreshes the reads opened from a link.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { clearIssueRefs, issueRefs, rememberIssueRef } from './issueRefs';

describe('issueRefs', () => {
  afterEach(() => {
    clearIssueRefs();
  });

  it('records each key text once and skips the id itself', () => {
    rememberIssueRef('ws-1', 'iss-1', 'ENG-12');
    rememberIssueRef('ws-1', 'iss-1', 'ENG-12');
    rememberIssueRef('ws-1', 'iss-1', 'iss-1');
    expect(issueRefs('ws-1', 'iss-1')).toEqual(['ENG-12']);
  });

  it('keeps workspaces apart', () => {
    rememberIssueRef('ws-1', 'iss-1', 'ENG-12');
    expect(issueRefs('ws-2', 'iss-1')).toEqual([]);
  });

  it('drops the oldest text past the limit', () => {
    for (let index = 0; index < 9; index += 1) {
      rememberIssueRef('ws-1', 'iss-1', `ENG-${index}`);
    }
    const held = issueRefs('ws-1', 'iss-1');
    expect(held).toHaveLength(8);
    expect(held).not.toContain('ENG-0');
    expect(held).toContain('ENG-8');
  });
});
