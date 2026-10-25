/**
 * The project and initiative routes' readable addresses: that a bare id, the
 * readable form and a stale slug all resolve to the same entity, and that the
 * address bar is rewritten in place to the current name's slug.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigationType,
} from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { useReadableAddress, useRouteEntityId } from './useReadableAddress';

const ID = '01M5SCBRDDWDSDX5WJDGTCV6CQ';

/** A page that shows the id it resolved and where the address bar is. */
const Page: React.FC<{ name: string | undefined }> = ({ name }) => {
  const id = useRouteEntityId();
  useReadableAddress(id, name);
  const location = useLocation();
  const navigation = useNavigationType();
  return (
    <>
      <p data-testid="id">{id}</p>
      <p data-testid="where">{`${location.pathname}${location.search}`}</p>
      <p data-testid="navigation">{navigation}</p>
    </>
  );
};

const renderAt = (path: string, name: string | undefined): void => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/w/:slug/projects/:id" element={<Page name={name} />} />
      </Routes>
    </MemoryRouter>
  );
};

describe('useReadableAddress', () => {
  it.each([
    ['a bare id', `/w/acme/projects/${ID}`],
    ['the readable form', `/w/acme/projects/launch-plan-${ID}`],
    ['a stale slug', `/w/acme/projects/old-name-${ID}`],
  ])('resolves %s and lands on the current slug', async (_label, path) => {
    renderAt(`${path}?tab=updates`, 'Launch Plan');

    expect(screen.getByTestId('id')).toHaveTextContent(ID);
    await waitFor(() => {
      expect(screen.getByTestId('where')).toHaveTextContent(
        `/w/acme/projects/launch-plan-${ID}?tab=updates`
      );
    });
    expect(screen.getByTestId('id')).toHaveTextContent(ID);
  });

  it('rewrites a stale slug with replace, leaving no history entry', async () => {
    renderAt(`/w/acme/projects/old-name-${ID}`, 'Launch Plan');

    await waitFor(() => {
      expect(screen.getByTestId('navigation')).toHaveTextContent('REPLACE');
    });
  });

  it('leaves the address alone until the name is known', () => {
    renderAt(`/w/acme/projects/old-name-${ID}`, undefined);

    expect(screen.getByTestId('where')).toHaveTextContent(
      `/w/acme/projects/old-name-${ID}`
    );
    expect(screen.getByTestId('navigation')).toHaveTextContent('POP');
  });

  it('keeps a non-ULID id as it is', () => {
    renderAt('/w/acme/projects/prj-1', 'Launch');

    expect(screen.getByTestId('id')).toHaveTextContent('prj-1');
    expect(screen.getByTestId('where')).toHaveTextContent(
      '/w/acme/projects/prj-1'
    );
  });
});
