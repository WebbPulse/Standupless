/**
 * Issue mentions in rendered Markdown. Covers that a key draws as a chip with
 * its status glyph, muted key and title linking to the issue, that every
 * mention in a body is read in one lookup, that inline code holding only a key
 * draws as a chip while other code stays code, that a long title sits on the
 * text line in one box that never wraps and truncates, and that a key naming
 * nothing the reader can see stays the text it was written as.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TeamsContext,
  type TeamsContextType,
} from '../../contexts/TeamsContextDefinition';
import {
  WorkspaceContext,
  type WorkspaceContextType,
} from '../../contexts/WorkspaceContextDefinition';
import { setMentionLookup } from '../../lib/issueMentions';
import type {
  IssueLookupRead,
  IssueRead,
  TeamRead,
  WorkspaceRead,
} from '../../types/Api';
import Markdown from './markdown';

vi.mock('../../api/teams', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listStatuses: () =>
    Promise.resolve([
      {
        id: 'st-1',
        name: 'In Progress',
        category: 'started',
        position: 1,
      },
    ]),
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

const workspaceValue: WorkspaceContextType = {
  workspace: { id: 'ws-chips', slug: 'acme' } as WorkspaceRead,
  isLoading: false,
  notFound: false,
  error: null,
  refresh: () => Promise.resolve(),
};

const teamsValue: TeamsContextType = {
  data: [{ id: 'team-1', key_prefix: 'ENG' } as TeamRead],
  isLoading: false,
  error: null,
  refetch: () => Promise.resolve(),
};

/** The issues the lookup knows, by key. */
const known: Record<string, IssueRead> = {
  'ENG-12': {
    id: 'iss-12',
    key: 'ENG-12',
    title: 'Ship the importer',
    team_id: 'team-1',
    status_id: 'st-1',
  } as IssueRead,
  'ENG-13': {
    id: 'iss-13',
    key: 'ENG-13',
    title: 'Write the runbook',
    team_id: 'team-1',
    status_id: 'st-1',
  } as IssueRead,
};

const lookup =
  vi.fn<
    (workspaceId: string, keys: readonly string[]) => Promise<IssueLookupRead>
  >();
let restore: () => void = () => undefined;

beforeEach(() => {
  lookup.mockReset();
  lookup.mockImplementation((_workspace, keys) => {
    const found = keys.flatMap((key) => {
      const issue = known[key];
      return issue === undefined ? [] : [issue];
    });
    return Promise.resolve({
      issues: found,
      resolved: Object.fromEntries(found.map((issue) => [issue.key, issue.id])),
    });
  });
  restore = setMentionLookup(lookup);
});

afterEach(() => {
  restore();
});

/** Renders Markdown inside the acme workspace with the ENG team. */
const renderBody = (source: string) =>
  render(
    <MemoryRouter>
      <WorkspaceContext.Provider value={workspaceValue}>
        <TeamsContext.Provider value={teamsValue}>
          <Markdown source={source} />
        </TeamsContext.Provider>
      </WorkspaceContext.Provider>
    </MemoryRouter>
  );

describe('IssueChip', () => {
  it('draws a key as a linked chip with its title, reading every mention at once', async () => {
    renderBody('Blocked on ENG-12 and ENG-13.');

    const title = await screen.findByText('Ship the importer');
    const chip = title.closest('a');
    expect(chip).toHaveAttribute('href', '/w/acme/issues/ENG-12');
    expect(chip?.querySelector('svg')).not.toBeNull();
    expect(await screen.findByText('Write the runbook')).toBeInTheDocument();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0]?.[1]).toEqual(['ENG-12', 'ENG-13']);
  });

  it('draws a long-titled chip as one inline box on the text line that truncates', async () => {
    renderBody('See ENG-12 now');

    const title = await screen.findByText('Ship the importer');
    const chip = title.closest('a');
    expect(chip?.parentElement?.tagName).toBe('P');
    expect(chip?.className.split(' ')).toEqual(
      expect.arrayContaining([
        'inline-flex',
        'whitespace-nowrap',
        'max-w-[min(24rem,100%)]',
        'align-baseline',
      ])
    );
    expect(title.className.split(' ')).toEqual(
      expect.arrayContaining(['min-w-0', 'truncate'])
    );
    expect(chip?.textContent).toBe('ENG-12Ship the importer');
    expect(chip?.parentElement?.textContent).toBe(
      'See ENG-12Ship the importer now'
    );
  });

  it('draws inline code holding only a key as a chip and leaves other code', async () => {
    const { container } = renderBody('See `ENG-12`, and run `make ENG-12`.');

    const title = await screen.findByText('Ship the importer');
    expect(title.closest('code')).toBeNull();
    expect(title.closest('a')).toHaveAttribute('href', '/w/acme/issues/ENG-12');
    const code = Array.from(container.querySelectorAll('code')).map(
      (node) => node.textContent
    );
    expect(code).toEqual(['make ENG-12']);
  });

  it('leaves a key naming nothing visible as the text it was written as', async () => {
    const { container } = renderBody('Blocked on ENG-99 and `ENG-98`.');

    await waitFor(() => {
      expect(lookup).toHaveBeenCalled();
    });
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('ENG-99');
    expect(container.querySelector('code')?.textContent).toBe('ENG-98');
  });
});
