/**
 * A document's thread and the passages it pins. Covers that the open threads
 * pinned to a passage are reported to the page's passage threads, so the body
 * highlights them, and that a resolved thread and a plain one are left out.
 */

import { render, screen, waitFor } from '@testing-library/react';
import type React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { usePassageThreads } from '../../contexts/PassageThreadsContextDefinition';
import PassageThreadsProvider from '../../contexts/PassageThreadsProvider';
import type { CommentListRead, CommentRead } from '../../types/Api';
import DocumentThread from './DocumentThread';

/** One root comment on the document, with the fields given. */
const root = (id: string, extra: Partial<CommentRead> = {}): CommentRead => ({
  comment_id: id,
  issue_id: 'doc-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  body: 'A thought',
  parent_comment_id: null,
  author_id: 'user-1',
  author: { user_id: 'user-1', display_name: 'Ada', email: 'ada@example.com' },
  mentions: [],
  reactions: [],
  reply_count: 0,
  document_id: 'doc-1',
  created_at: `2026-10-2${id.slice(-1)}T10:00:00Z`,
  edited_at: null,
  ...extra,
});

const page: CommentListRead = {
  comments: [
    root('c-1', { anchor: { quote: 'worker', prefix: '', suffix: '' } }),
    root('c-2'),
    root('c-3', {
      anchor: { quote: 'deploy', prefix: '', suffix: '' },
      resolution: {
        resolved_by: 'user-1',
        resolved_at: '2026-10-24T10:00:00Z',
      },
    }),
  ],
  next_cursor: null,
};

vi.mock('../../api/discussion', async () => {
  const actual = await vi.importActual<typeof import('../../api/discussion')>(
    '../../api/discussion'
  );
  return {
    ...actual,
    listDocumentComments: () => Promise.resolve(page),
  };
});

vi.mock('../discussion/CommentCard', () => ({
  default: () => null,
}));

vi.mock('../discussion/CommentComposer', () => ({
  default: () => null,
}));

vi.mock('../print/PrintEndnotes', () => ({
  default: () => null,
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

/** Lists the threads the provider holds, as the document body reads them. */
const Pinned = (): React.JSX.Element => {
  const passages = usePassageThreads();
  return (
    <p data-testid="pinned">
      {(passages?.threads ?? [])
        .map((thread) => `${thread.commentId}:${thread.anchor.quote}`)
        .join(',')}
    </p>
  );
};

describe('a document thread', () => {
  it('reports its open pinned threads to the page', async () => {
    render(
      <MemoryRouter>
        <PassageThreadsProvider>
          <Pinned />
          <DocumentThread
            workspaceId="ws-1"
            documentId="doc-1"
            currentUserId="user-1"
            canComment
            canModerate={false}
            people={[]}
          />
        </PassageThreadsProvider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByTestId('pinned').textContent).toBe('c-1:worker');
    });
  });
});
