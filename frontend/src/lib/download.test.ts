/** The export file name parts and the download hand-off. */

import { describe, expect, it, vi } from 'vitest';
import { downloadText, fileSlug, todayStamp } from './download';

describe('download', () => {
  it('builds a file name from any label', () => {
    expect(fileSlug('Engineering: Urgent bugs!')).toBe(
      'engineering-urgent-bugs'
    );
    expect(fileSlug('***')).toBe('issues');
    expect(todayStamp(new Date('2026-10-06T12:00:00Z'))).toBe('2026-10-06');
  });

  it('clicks a temporary link and releases its URL', () => {
    const create = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    downloadText('a,b\r\n', 'out.csv');

    expect(create).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:x');
    expect(document.querySelector('a[download]')).toBeNull();
    click.mockRestore();
  });
});
