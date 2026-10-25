/**
 * Opening closed sections for a print. Covers that a closed section opens
 * for the print and closes after it, that a section already open stays open,
 * and that the listeners stop when uninstalled.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  installPrintExpansion,
  openSectionsForPrint,
  restoreSectionsAfterPrint,
} from './print';

afterEach(() => {
  document.body.innerHTML = '';
});

/** One closed and one open section in the page. */
const sections = (): [HTMLDetailsElement, HTMLDetailsElement] => {
  document.body.innerHTML =
    '<details id="closed"><summary>a</summary>x</details>' +
    '<details id="open" open><summary>b</summary>y</details>';
  return [
    document.getElementById('closed') as HTMLDetailsElement,
    document.getElementById('open') as HTMLDetailsElement,
  ];
};

describe('print sections', () => {
  it('opens closed sections and closes only those afterwards', () => {
    const [closed, open] = sections();
    openSectionsForPrint();
    expect(closed.open).toBe(true);
    expect(open.open).toBe(true);
    restoreSectionsAfterPrint();
    expect(closed.open).toBe(false);
    expect(open.open).toBe(true);
  });

  it('follows the browser print events until uninstalled', () => {
    const [closed] = sections();
    const uninstall = installPrintExpansion(window);
    window.dispatchEvent(new Event('beforeprint'));
    expect(closed.open).toBe(true);
    window.dispatchEvent(new Event('afterprint'));
    expect(closed.open).toBe(false);
    uninstall();
    window.dispatchEvent(new Event('beforeprint'));
    expect(closed.open).toBe(false);
  });
});
