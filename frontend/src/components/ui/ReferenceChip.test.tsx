/**
 * Project and document links in rendered Markdown. Covers that a link to a
 * page of the open workspace draws as a chip that routes in the app and shows
 * the target's current name, that the link's own text shows until that read
 * lands, and that links outside the workspace stay ordinary links.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WorkspaceContext,
  type WorkspaceContextType,
} from '../../contexts/WorkspaceContextDefinition';
import type { DocumentRead, ProjectRead, WorkspaceRead } from '../../types/Api';
import Markdown from './markdown';

const getProject = vi.fn<(id: string) => Promise<ProjectRead>>();
const getDocument = vi.fn<(id: string) => Promise<DocumentRead>>();

vi.mock('../../api/planning', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getProject: (_w: string, id: string) => getProject(id),
}));

vi.mock('../../api/documents', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDocument: (_w: string, id: string) => getDocument(id),
}));

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

/** The workspace context a page under `/w/acme` sees. */
const workspaceValue: WorkspaceContextType = {
  workspace: { id: 'ws-1', slug: 'acme' } as WorkspaceRead,
  isLoading: false,
  notFound: false,
  error: null,
  refresh: () => Promise.resolve(),
};

/** Renders Markdown inside the acme workspace, or outside any when `inside` is false. */
const renderBody = (source: string, inside = true) =>
  render(
    <MemoryRouter>
      {inside ? (
        <WorkspaceContext.Provider value={workspaceValue}>
          <Markdown source={source} />
        </WorkspaceContext.Provider>
      ) : (
        <Markdown source={source} />
      )}
    </MemoryRouter>
  );

const origin = window.location.origin;

beforeEach(() => {
  getProject.mockReset();
  getDocument.mockReset();
});

describe('ReferenceChip', () => {
  it('draws a project link as a chip with its current name', async () => {
    getProject.mockResolvedValue({
      project_id: 'prj-1',
      name: 'Roadmap 2027',
      icon: null,
      color: null,
    } as unknown as ProjectRead);

    renderBody(`See [Roadmap](${origin}/w/acme/projects/prj-1) soon`);

    const chip = await screen.findByRole('link', { name: 'Roadmap 2027' });
    expect(chip).toHaveAttribute('data-reference', 'project');
    expect(chip).toHaveAttribute('href', '/w/acme/projects/prj-1');
    expect(chip).not.toHaveAttribute('target');
    expect(getProject).toHaveBeenCalledWith('prj-1');
  });

  it('draws a document link as a chip with its current title', async () => {
    getDocument.mockResolvedValue({
      document_id: 'doc-1',
      title: 'Launch plan',
    } as unknown as DocumentRead);

    renderBody(`[Plan](${origin}/w/acme/documents/doc-1)`);

    const chip = await screen.findByRole('link', { name: 'Launch plan' });
    expect(chip).toHaveAttribute('data-reference', 'document');
    expect(chip).toHaveAttribute('href', '/w/acme/documents/doc-1');
  });

  it('shows the written name until the target is read', () => {
    getProject.mockReturnValue(new Promise<ProjectRead>(() => undefined));

    renderBody(`[Roadmap](${origin}/w/acme/projects/prj-1)`);

    const chip = screen.getByRole('link', { name: 'Roadmap' });
    expect(chip).toHaveAttribute('data-reference', 'project');
  });

  it('keeps a link to another workspace an ordinary link', () => {
    renderBody(`[Theirs](${origin}/w/other/projects/prj-1)`);

    const link = screen.getByRole('link', { name: 'Theirs' });
    expect(link).not.toHaveAttribute('data-reference');
    expect(link).toHaveAttribute('target', '_blank');
    expect(getProject).not.toHaveBeenCalled();
  });

  it('keeps a link to another site an ordinary link', () => {
    renderBody('[Site](https://elsewhere.example.com/w/acme/projects/prj-1)');

    expect(screen.getByRole('link', { name: 'Site' })).not.toHaveAttribute(
      'data-reference'
    );
  });

  it('keeps project links ordinary outside a workspace', () => {
    renderBody(`[Roadmap](${origin}/w/acme/projects/prj-1)`, false);

    expect(screen.getByRole('link', { name: 'Roadmap' })).not.toHaveAttribute(
      'data-reference'
    );
    expect(getProject).not.toHaveBeenCalled();
  });
});
