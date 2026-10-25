/**
 * The document version history. Covers that the current text and the kept
 * versions are listed newest first with their authors, that the selected
 * version reads as a line diff against the current body or in full, that
 * Restore sends the version with the body version it was chosen against and
 * offers an undo that writes the replaced body back, that a refused restore
 * says so, and that a reader who may not edit sees no Restore.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentRead, DocumentVersionRead } from '../../types/Api';
import DocumentHistoryDialog from './DocumentHistoryDialog';

const listDocumentVersions = vi.fn<() => Promise<DocumentVersionRead[]>>();
const restoreDocumentVersion =
  vi.fn<
    (
      workspaceId: string,
      documentId: string,
      versionId: string,
      baseBodyVersion?: string
    ) => Promise<DocumentRead>
  >();
const updateDocument =
  vi.fn<
    (
      workspaceId: string,
      documentId: string,
      body: object
    ) => Promise<DocumentRead>
  >();
const pushUndo =
  vi.fn<
    (workspaceId: string, message: string, revert: () => Promise<void>) => void
  >();
const showErrorToast = vi.fn<(message: string) => void>();

vi.mock('../../api/documents', () => ({
  listDocumentVersions: () => listDocumentVersions(),
  restoreDocumentVersion: (
    workspaceId: string,
    documentId: string,
    versionId: string,
    baseBodyVersion?: string
  ) =>
    restoreDocumentVersion(workspaceId, documentId, versionId, baseBodyVersion),
  updateDocument: (workspaceId: string, documentId: string, body: object) =>
    updateDocument(workspaceId, documentId, body),
}));

vi.mock('../../lib/undo', () => ({
  pushUndo: (
    workspaceId: string,
    message: string,
    revert: () => Promise<void>
  ) => {
    pushUndo(workspaceId, message, revert);
  },
}));

vi.mock('../../lib/toast', async () => {
  const actual =
    await vi.importActual<typeof import('../../lib/toast')>('../../lib/toast');
  return {
    ...actual,
    showErrorToast: (message: string) => {
      showErrorToast(message);
    },
  };
});

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

const people = [
  {
    user_id: 'user-1',
    email: 'ada@example.com',
    display_name: 'Ada',
    avatar_url: null,
    full_name: '',
  },
  {
    user_id: 'user-2',
    email: 'bo@example.com',
    display_name: 'Bo',
    avatar_url: null,
    full_name: '',
  },
];

/** The document as the page holds it. */
const page = (overrides: Partial<DocumentRead> = {}): DocumentRead => ({
  document_id: 'doc-1',
  workspace_id: 'ws-1',
  parent_kind: 'team',
  parent_id: 'team-1',
  parent_name: 'Engine',
  title: 'Launch plan',
  icon: null,
  author_id: 'user-2',
  updated_by: 'user-1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-03T00:00:00Z',
  can_edit: true,
  can_delete: true,
  body: 'Ship on Friday\nTell support',
  body_version: 'current-version',
  mentions: [],
  ...overrides,
});

/** One kept version. */
const version = (
  id: string,
  body: string,
  editedBy: string,
  editedAt: string
): DocumentVersionRead => ({
  version_id: id,
  document_id: 'doc-1',
  title: 'Launch plan',
  body,
  edited_by: editedBy,
  edited_at: editedAt,
});

const older = version(
  'v-2',
  'Ship on Monday\nTell support',
  'user-2',
  '2026-10-02T00:00:00Z'
);
const oldest = version('v-1', 'Ship soon', 'user-2', '2026-10-01T00:00:00Z');

/** Renders the dialog over one document, answering its callbacks. */
const renderDialog = (document: DocumentRead = page()) => {
  const onRestored = vi.fn<(document: DocumentRead) => void>();
  const onClose = vi.fn<() => void>();
  render(
    <DocumentHistoryDialog
      workspaceId="ws-1"
      document={document}
      people={people}
      onRestored={onRestored}
      onClose={onClose}
    />
  );
  return { onRestored, onClose };
};

describe('DocumentHistoryDialog', () => {
  beforeEach(() => {
    listDocumentVersions.mockReset();
    listDocumentVersions.mockResolvedValue([older, oldest]);
    restoreDocumentVersion.mockReset();
    updateDocument.mockReset();
    pushUndo.mockReset();
    showErrorToast.mockReset();
  });

  it('lists the current text and the kept versions newest first with their authors', async () => {
    renderDialog();

    const list = await screen.findByRole('list', { name: 'Versions' });
    const rows = within(list).getAllByRole('button');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Current');
    expect(rows[0]).toHaveTextContent('Ada');
    expect(rows[1]).toHaveTextContent('Bo');
    expect(rows[1]).toHaveAttribute('aria-current', 'true');
  });

  it('shows the selected version as a line diff against the current body, or in full', async () => {
    const user = userEvent.setup();
    renderDialog();

    const diff = await screen.findByLabelText(
      'Changes against the current document'
    );
    expect(diff).toHaveTextContent('In this version: Ship on Monday');
    expect(diff).toHaveTextContent('In the current document: Ship on Friday');

    await user.click(screen.getByRole('button', { name: 'Full text' }));
    expect(
      screen.queryByLabelText('Changes against the current document')
    ).toBeNull();
    expect(screen.getByText(/Ship on Monday/)).toBeInTheDocument();
  });

  it('restores against the body version it was chosen on and offers an undo', async () => {
    const user = userEvent.setup();
    const restored = page({
      body: older.body,
      body_version: 'restored-version',
      updated_at: '2026-10-04T00:00:00Z',
    });
    const reverted = page({ updated_at: '2026-10-05T00:00:00Z' });
    restoreDocumentVersion.mockResolvedValue(restored);
    updateDocument.mockResolvedValue(reverted);
    const { onRestored, onClose } = renderDialog();

    await user.click(await screen.findByRole('button', { name: 'Restore' }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(restoreDocumentVersion).toHaveBeenCalledWith(
      'ws-1',
      'doc-1',
      'v-2',
      'current-version'
    );
    expect(onRestored).toHaveBeenCalledWith(restored);
    expect(pushUndo).toHaveBeenCalledTimes(1);
    const [workspaceId, message, revert] = pushUndo.mock.calls[0] ?? [];
    expect(workspaceId).toBe('ws-1');
    expect(message).toBe('Restored Launch plan');

    await revert?.();
    expect(updateDocument).toHaveBeenCalledWith('ws-1', 'doc-1', {
      body: 'Ship on Friday\nTell support',
      base_body_version: 'restored-version',
    });
    expect(onRestored).toHaveBeenLastCalledWith(reverted);
  });

  it('says so when a restore is refused and keeps the dialog open', async () => {
    const user = userEvent.setup();
    restoreDocumentVersion.mockRejectedValue(new Error('The body changed'));
    const { onRestored, onClose } = renderDialog();

    await user.click(await screen.findByRole('button', { name: 'Restore' }));

    await waitFor(() => {
      expect(showErrorToast).toHaveBeenCalled();
    });
    expect(onRestored).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(pushUndo).not.toHaveBeenCalled();
  });

  it('offers no restore to a reader who may not edit, or on the current text', async () => {
    const user = userEvent.setup();
    renderDialog(page({ can_edit: false }));

    await screen.findByRole('list', { name: 'Versions' });
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();

    await user.click(screen.getByRole('button', { name: /Current/ }));
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
  });

  it('says there is nothing earlier when no version is kept', async () => {
    listDocumentVersions.mockResolvedValue([]);
    renderDialog();

    expect(
      await screen.findByText('No earlier versions yet.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Versions' })).toBeNull();
  });
});
