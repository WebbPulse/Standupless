/**
 * Tests for the route error boundary: a page that throws never leaves the
 * screen empty, trying again recovers, a pruned chunk reloads once and then
 * shows the error, and moving to another address clears it.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RouteErrorBoundary from './RouteErrorBoundary';

let failure: Error | null = null;

/** A page that throws whatever `failure` holds while rendering. */
const Flaky: React.FC = () => {
  if (failure !== null) throw failure;
  return <p>Project overview</p>;
};

const chunkError = (): Error =>
  new TypeError(
    'Failed to fetch dynamically imported module: https://standupless.dev/assets/RichMarkdownEditor-abc.js'
  );

const renderBoundary = (reloadForChunk = vi.fn(() => false)) =>
  render(
    <MemoryRouter initialEntries={['/w/mine/projects/prj-1']}>
      <Link to="/w/mine/projects">All projects</Link>
      <RouteErrorBoundary reloadForChunk={reloadForChunk}>
        <Routes>
          <Route path="/w/:slug/projects/:id" element={<Flaky />} />
          <Route path="/w/:slug/projects" element={<p>Projects list</p>} />
        </Routes>
      </RouteErrorBoundary>
    </MemoryRouter>
  );

describe('RouteErrorBoundary', () => {
  beforeEach(() => {
    failure = null;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the page when nothing throws', () => {
    renderBoundary();
    expect(screen.getByText('Project overview')).toBeInTheDocument();
  });

  it('shows an error state instead of an empty screen and recovers on retry', async () => {
    const user = userEvent.setup();
    failure = new TypeError(
      "Cannot read properties of undefined (reading 'name')"
    );
    renderBoundary();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'This page could not be shown'
    );
    failure = null;
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByText('Project overview')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reloads once for a chunk that failed to load', () => {
    const reload = vi.fn(() => true);
    failure = chunkError();
    renderBoundary(reload);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(
      screen.getByLabelText('Loading the latest version')
    ).toBeInTheDocument();
    expect(screen.queryByText('Project overview')).not.toBeInTheDocument();
  });

  it('shows the error when the chunk still fails after the reload', () => {
    const reload = vi.fn(() => false);
    failure = chunkError();
    renderBoundary(reload);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Standupless was updated while this tab was open'
    );
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('clears the error when the address moves on', async () => {
    const user = userEvent.setup();
    failure = new Error('Render failed');
    renderBoundary();

    expect(screen.getByRole('alert')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'All projects' }));

    expect(screen.getByText('Projects list')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('draws a custom fallback when one is given', () => {
    failure = new Error('Render failed');
    render(
      <MemoryRouter>
        <RouteErrorBoundary
          fallback={({ retry }) => (
            <button type="button" onClick={retry}>
              Custom fallback
            </button>
          )}
        >
          <Flaky />
        </RouteErrorBoundary>
      </MemoryRouter>
    );

    expect(
      screen.getByRole('button', { name: 'Custom fallback' })
    ).toBeInTheDocument();
  });
});
