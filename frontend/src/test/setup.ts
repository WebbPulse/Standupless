/**
 * Global vitest setup. Registers the jest-dom matchers and unmounts whatever a
 * test rendered once it finishes.
 *
 * The cleanup is explicit rather than left to Testing Library's automatic hook,
 * because a component left mounted keeps its document level listeners. Two
 * tests that each render a list and then dispatch a keydown on the document
 * would otherwise reach each other's rows, which shows up as a failure in
 * whichever test happens to run second. Local storage is emptied for the same
 * reason, since a list remembers its folded groups there, and the shared read
 * cache is emptied so one test's answers never reach the next.
 *
 * The async queries get a five second budget instead of Testing Library's one
 * second. A page's mocked reads settle in a few dozen milliseconds, but the
 * first render in a file runs cold and a CI runner shares its cores between
 * the test workers and coverage, so a wait that covers a chain of dependent
 * reads can pass one second without anything being wrong. The budget only
 * bounds how long a failing wait takes to report; a passing wait returns as
 * soon as its condition holds.
 *
 * jsdom lays nothing out, so text nodes and ranges have no client rects. An
 * editor that opens focused scrolls its caret into view a frame later, which
 * asks a text node for its rects, so both answer with an empty box here.
 */

import '@testing-library/jest-dom';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';
import { clearSharedGetCache } from '../api/sharedFetch';

configure({ asyncUtilTimeout: 5000 });

const emptyRect = (): DOMRect => new DOMRect(0, 0, 0, 0);
const emptyRects = (): DOMRect[] => [emptyRect()];

for (const prototype of [Text.prototype, Range.prototype]) {
  if (!('getClientRects' in prototype)) {
    Object.defineProperty(prototype, 'getClientRects', {
      configurable: true,
      value: emptyRects,
    });
  }
  if (!('getBoundingClientRect' in prototype)) {
    Object.defineProperty(prototype, 'getBoundingClientRect', {
      configurable: true,
      value: emptyRect,
    });
  }
}

afterEach(() => {
  cleanup();
  globalThis.localStorage.clear();
  clearSharedGetCache();
});
