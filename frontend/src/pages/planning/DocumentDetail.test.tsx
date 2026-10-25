/**
 * One document's page and its keys. Covers that R focuses and selects the
 * title for a person who may edit it and stands down for one who may not or
 * while the body is being typed in, and that Cmd or Ctrl+Shift+Comma copies
 * the document's address, as Linear binds them, and that Cmd or Ctrl+Alt+M,
 * which comments on a selected passage, is bound for a person who may comment
 * and not for one who may not.
 */

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type { DocumentRead } from '../../types/Api';
import ShortcutProvider from '../../components/shortcuts/ShortcutProvider';
import { documentPath } from '../../lib/paths';
import BoundKeys from '../../test/BoundKeys';
import { boundKeys, keysBound } from '../../test/shortcuts';
import DocumentDetail from './DocumentDetail';

const getDocument = vi.fn<() => Promise<DocumentRead>>();

vi.mock('../../api/documents', async () => {
  const actual = await vi.importActual<typeof import('../../api/documents')>(
    '../../api/documents'
  );
  return {
    ...actual,
    getDocument: () => getDocument(),
    listDocumentVersions: () => Promise.resolve([]),
    updateDocument: vi.fn(),
    deleteDocument: vi.fn(),
  };
});

vi.mock('../../api/views', async () => ({
  ...(await vi.importActual<typeof import('../../api/views')>(
    '../../api/views'
  )),
  listEntityReminders: () => Promise.resolve([]),
  setEntityReminder: vi.fn(),
  cancelEntityReminder: vi.fn(),
}));

vi.mock('../../api/discussion', async () => {
  const actual = await vi.importActual<typeof import('../../api/discussion')>(
    '../../api/discussion'
  );
  return {
    ...actual,
    listDocumentSubscribers: () =>
      Promise.resolve({ subscribers: [], subscribed: true }),
    setDocumentSubscribed: vi.fn(),
  };
});

vi.mock('../../components/planning/DocumentThread', () => ({
  default: () => null,
}));

vi.mock('../../components/ui/FavoriteButton', () => ({
  default: () => null,
}));

vi.mock('../../hooks/useWorkspaceMembers', () => ({
  useWorkspaceMembers: () => [],
}));

vi.mock('../../hooks/useTeams', () => {
  const teams = {
    data: [],
    isLoading: false,
    error: null,
    refetch: () => Promise.resolve(),
    workspaceId: 'ws-1',
  };
  return {
    default: () => teams,
    useTeams: () => teams,
    useTeamsFor: () => teams,
  };
});

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: { id: 'user-1', email: 'ada@example.com', display_name: 'Ada' },
    isLoading: false,
    isBusy: false,
    login: vi.fn(),
    logout: vi.fn(),
    checkAuthStatus: vi.fn(),
  }),
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

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: (): WorkspaceContextType => ({
    workspace: {
      id: 'ws-1',
      name: 'Mine',
      slug: 'mine',
      plan: 'free',
      created_at: '2026-09-17T00:00:00Z',
      role: 'admin',
    },
    isLoading: false,
    notFound: false,
    error: null,
    refresh: vi.fn(() => Promise.resolve()),
  }),
}));

/** The document the page reads. */
const spec: DocumentRead = {
  document_id: 'doc-1',
  workspace_id: 'ws-1',
  parent_kind: 'team',
  parent_id: 'team-1',
  parent_name: 'Engine',
  title: 'Launch plan',
  icon: null,
  author_id: 'user-1',
  updated_by: 'user-1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  can_edit: true,
  can_delete: true,
  body: 'The plan.',
  mentions: [],
};

/** Renders the page inside a shortcut registry, as the workspace shell does. */
const renderWithKeys = () =>
  render(
    <ShortcutProvider>
      <BoundKeys />
      <MemoryRouter initialEntries={['/w/mine/documents/doc-1']}>
        <Routes>
          <Route
            path="/w/:slug/documents/:documentId"
            element={<DocumentDetail />}
          />
        </Routes>
      </MemoryRouter>
    </ShortcutProvider>
  );

/** Dispatches one key at `target` the way the shortcut layer listens for it. */
const press = (
  key: string,
  init: KeyboardEventInit = {},
  target: HTMLElement = document.body
) => {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, ...init })
    );
  });
};

describe('DocumentDetail keyboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDocument.mockResolvedValue(spec);
  });

  it('focuses and selects the title on R', async () => {
    renderWithKeys();
    const title = await screen.findByRole<HTMLInputElement>('textbox', {
      name: 'Document title',
    });
    await keysBound('r');

    press('r');

    expect(title).toHaveFocus();
    expect(title.selectionStart).toBe(0);
    expect(title.selectionEnd).toBe('Launch plan'.length);
  });

  it('leaves R to the body being typed in', async () => {
    renderWithKeys();
    const title = await screen.findByRole('textbox', {
      name: 'Document title',
    });
    await keysBound('r');
    const typing = document.createElement('textarea');
    document.body.append(typing);
    typing.focus();

    press('r', {}, typing);

    expect(title).not.toHaveFocus();
    typing.remove();
  });

  it('does not bind R when the document cannot be edited', async () => {
    getDocument.mockResolvedValue({ ...spec, can_edit: false });
    renderWithKeys();
    await screen.findByRole('textbox', { name: 'Document title' });
    await keysBound('mod+shift+,');

    expect(boundKeys()).not.toContain('r');
  });

  it('opens the reminder dialog from its actions menu', async () => {
    const user = userEvent.setup();
    renderWithKeys();
    await screen.findByRole('textbox', { name: 'Document title' });

    await user.click(screen.getByRole('button', { name: 'Document actions' }));
    await user.click(
      await screen.findByRole('menuitem', { name: /Remind me/ })
    );

    expect(
      await screen.findByText(
        'Launch plan comes back to your inbox at the time you pick.'
      )
    ).toBeInTheDocument();
  });

  it('opens the reminder dialog on H', async () => {
    renderWithKeys();
    await screen.findByRole('textbox', { name: 'Document title' });
    await keysBound('h');

    press('h');

    expect(
      await screen.findByText(
        'Launch plan comes back to your inbox at the time you pick.'
      )
    ).toBeInTheDocument();
  });

  it('copies the document URL on Cmd or Ctrl+Shift+,', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    renderWithKeys();
    await screen.findByRole('textbox', { name: 'Document title' });
    await keysBound('mod+shift+,');

    press('<', { ctrlKey: true, shiftKey: true, code: 'Comma' });

    expect(writeText).toHaveBeenCalledWith(
      `${globalThis.location.origin}${documentPath('mine', 'doc-1')}`
    );
  });

  it('binds Cmd or Ctrl+Alt+M to comment on a passage', async () => {
    renderWithKeys();
    await screen.findByRole('textbox', { name: 'Document' }, { timeout: 5000 });

    await keysBound('mod+alt+m');
  });

  it('does not bind passage comments when the document cannot be edited', async () => {
    getDocument.mockResolvedValue({ ...spec, can_edit: false });
    renderWithKeys();
    await screen.findByRole('textbox', { name: 'Document' }, { timeout: 5000 });
    await keysBound('mod+shift+,');

    expect(boundKeys()).not.toContain('mod+alt+m');
  });
});
