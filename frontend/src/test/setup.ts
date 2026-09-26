/**
 * Global vitest setup. Registers the jest-dom matchers and unmounts whatever a
 * test rendered once it finishes.
 *
 * The cleanup is explicit rather than left to Testing Library's automatic hook,
 * because a component left mounted keeps its document level listeners. Two
 * tests that each render a list and then dispatch a keydown on the document
 * would otherwise reach each other's rows, which shows up as a failure in
 * whichever test happens to run second.
 */

import '@testing-library/jest-dom';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
