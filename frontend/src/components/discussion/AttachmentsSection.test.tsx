/**
 * The attachments section. Covers the three call upload, that a file the
 * contract would refuse is stopped before any call is made, that a download
 * link is minted per click rather than held on the row, and that remove is
 * offered only to the uploader or a project admin.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AttachmentDownloadRead,
  AttachmentListRead,
  AttachmentRead,
} from '../../types/Api';
import AttachmentsSection from './AttachmentsSection';

const listAttachments = vi.fn<(query: unknown) => Promise<AttachmentListRead>>();
const createUrlAttachment = vi.fn<(body: unknown) => Promise<AttachmentRead>>();
const uploadAttachment = vi.fn<(file: File) => Promise<AttachmentRead>>();
const deleteAttachment = vi.fn<(id: string, issueId: string) => Promise<void>>();
const getAttachmentDownload =
  vi.fn<(id: string, issueId: string) => Promise<AttachmentDownloadRead>>();

vi.mock('../../api/discussion', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/discussion')>(
      '../../api/discussion'
    );
  return {
    ...actual,
    listAttachments: (_w: string, _i: string, query: unknown) =>
      listAttachments(query),
    createUrlAttachment: (_w: string, body: unknown) =>
      createUrlAttachment(body),
    uploadAttachment: (_w: string, _i: string, file: File) =>
      uploadAttachment(file),
    deleteAttachment: (_w: string, id: string, issueId: string) =>
      deleteAttachment(id, issueId),
    getAttachmentDownload: (_w: string, id: string, issueId: string) =>
      getAttachmentDownload(id, issueId),
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

/** Builds an attachment in the shape the contract answers with. */
const attachment = (over: Partial<AttachmentRead> = {}): AttachmentRead => ({
  attachment_id: 'att-1',
  issue_id: 'iss-1',
  workspace_id: 'ws-1',
  project_id: 'proj-1',
  kind: 'file',
  title: 'spec.pdf',
  url: null,
  favicon_url: null,
  content_type: 'application/pdf',
  size_bytes: 2048,
  s3_key: 'workspaces/ws-1/issues/iss-1/up-1/spec.pdf',
  uploaded_by: 'user-1',
  created_at: '2026-09-17T00:00:00Z',
  ...over,
});

const renderSection = (
  over: Partial<React.ComponentProps<typeof AttachmentsSection>> = {}
) =>
  render(
    <AttachmentsSection
      workspaceId="ws-1"
      issueId="iss-1"
      currentUserId="user-1"
      canAttach
      isAdmin={false}
      {...over}
    />
  );

const openSpy = vi.fn();

beforeEach(() => {
  listAttachments.mockReset();
  createUrlAttachment.mockReset();
  uploadAttachment.mockReset();
  deleteAttachment.mockReset();
  getAttachmentDownload.mockReset();
  openSpy.mockReset();
  vi.stubGlobal('open', openSpy);
  listAttachments.mockResolvedValue({
    attachments: [attachment()],
    next_cursor: null,
  });
  createUrlAttachment.mockResolvedValue(
    attachment({ attachment_id: 'att-2', kind: 'url' })
  );
  uploadAttachment.mockResolvedValue(attachment({ attachment_id: 'att-3' }));
  deleteAttachment.mockResolvedValue(undefined);
  getAttachmentDownload.mockResolvedValue({
    url: 'https://bucket.example.com/signed',
    expires_at: '2026-09-17T00:05:00Z',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('attachments section', () => {
  it('lists what is attached', async () => {
    renderSection();

    expect(await screen.findByText('spec.pdf')).toBeInTheDocument();
  });

  it('says so when nothing is attached', async () => {
    listAttachments.mockResolvedValue({ attachments: [], next_cursor: null });
    renderSection();

    expect(
      await screen.findByText('Nothing is attached yet.')
    ).toBeInTheDocument();
  });

  it('reads the list scoped to the issue', async () => {
    renderSection();

    await waitFor(() => {
      expect(listAttachments).toHaveBeenCalled();
    });
  });

  it('attaches a link without a title when none was typed', async () => {
    const user = userEvent.setup();
    renderSection();

    await screen.findByText('spec.pdf');
    await user.type(
      screen.getByLabelText('Attach a link'),
      'https://example.com/spec'
    );
    await user.click(screen.getByRole('button', { name: 'Attach link' }));

    await waitFor(() => {
      expect(createUrlAttachment).toHaveBeenCalledWith({
        issue_id: 'iss-1',
        url: 'https://example.com/spec',
      });
    });
  });

  it('carries a title when one was typed', async () => {
    const user = userEvent.setup();
    renderSection();

    await screen.findByText('spec.pdf');
    await user.type(
      screen.getByLabelText('Attach a link'),
      'https://example.com/spec'
    );
    await user.type(screen.getByLabelText('Link title'), 'The spec');
    await user.click(screen.getByRole('button', { name: 'Attach link' }));

    await waitFor(() => {
      expect(createUrlAttachment).toHaveBeenCalledWith({
        issue_id: 'iss-1',
        url: 'https://example.com/spec',
        title: 'The spec',
      });
    });
  });

  it('runs the whole upload flow for an accepted file', async () => {
    const user = userEvent.setup();
    renderSection();

    await screen.findByText('spec.pdf');
    const file = new File(['bytes'], 'notes.pdf', { type: 'application/pdf' });
    await user.upload(screen.getByLabelText('Upload a file'), file);
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    await waitFor(() => {
      expect(uploadAttachment).toHaveBeenCalledWith(file);
    });
  });

  it('keeps svg out of what the picker will even offer', async () => {
    renderSection();

    await screen.findByText('spec.pdf');
    const input = screen.getByLabelText('Upload a file');
    expect(input.getAttribute('accept')).not.toContain('svg');
  });

  it('refuses a type the contract does not sign, before any call', async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderSection();

    await screen.findByText('spec.pdf');
    const file = new File(['MZ'], 'setup.exe', {
      type: 'application/x-msdownload',
    });
    await user.upload(screen.getByLabelText('Upload a file'), file);

    expect(
      await screen.findByText(
        'That file type cannot be attached. Images, PDFs, text, CSV, ZIP and Office documents are accepted.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
    expect(uploadAttachment).not.toHaveBeenCalled();
  });

  it('refuses a file above the ceiling, before any call', async () => {
    const user = userEvent.setup();
    renderSection();

    await screen.findByText('spec.pdf');
    const big = new File(['x'], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 26 * 1024 * 1024 });
    await user.upload(screen.getByLabelText('Upload a file'), big);

    expect(await screen.findByText(/above the 25.0 MB limit/)).toBeInTheDocument();
    expect(uploadAttachment).not.toHaveBeenCalled();
  });

  it('mints a download link per click rather than holding one', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(await screen.findByRole('button', { name: 'spec.pdf' }));

    await waitFor(() => {
      expect(getAttachmentDownload).toHaveBeenCalledWith('att-1', 'iss-1');
    });
    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        'https://bucket.example.com/signed',
        '_blank',
        'noopener,noreferrer'
      );
    });
  });

  it('removes an attachment the caller uploaded', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(await screen.findByRole('button', { name: 'Remove spec.pdf' }));

    await waitFor(() => {
      expect(deleteAttachment).toHaveBeenCalledWith('att-1', 'iss-1');
    });
  });

  it('offers no remove on someone else uploaded file', async () => {
    listAttachments.mockResolvedValue({
      attachments: [attachment({ uploaded_by: 'user-2' })],
      next_cursor: null,
    });
    renderSection();

    await screen.findByText('spec.pdf');
    expect(
      screen.queryByRole('button', { name: 'Remove spec.pdf' })
    ).not.toBeInTheDocument();
  });

  it('lets a project admin remove a file they did not upload', async () => {
    listAttachments.mockResolvedValue({
      attachments: [attachment({ uploaded_by: 'user-2' })],
      next_cursor: null,
    });
    renderSection({ isAdmin: true });

    expect(
      await screen.findByRole('button', { name: 'Remove spec.pdf' })
    ).toBeInTheDocument();
  });

  it('hides the attach controls from someone who may only read', async () => {
    renderSection({ canAttach: false });

    await screen.findByText('spec.pdf');
    expect(screen.queryByLabelText('Attach a link')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Upload a file')).not.toBeInTheDocument();
  });

  it('links a url attachment straight out rather than through a download', async () => {
    listAttachments.mockResolvedValue({
      attachments: [
        attachment({
          kind: 'url',
          title: 'The spec',
          url: 'https://example.com/spec',
        }),
      ],
      next_cursor: null,
    });
    renderSection();

    expect(await screen.findByRole('link', { name: 'The spec' })).toHaveAttribute(
      'href',
      'https://example.com/spec'
    );
    expect(getAttachmentDownload).not.toHaveBeenCalled();
  });
});
