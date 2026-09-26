/**
 * The issue title and description, edited as the text they render as. Covers
 * that there is no pencil and no edit mode, that the description is the
 * formatted document, that leaving it or Ctrl or Cmd Enter saves the Markdown
 * while Escape puts the saved text back, that an unchanged document saves
 * nothing, that a click on a link follows it, that a pasted image uploads
 * behind a progress bar and lands in the text by its content path, that any
 * other file lands as a link, and that a reader gets the same surface read only.
 */

import type { Editor } from '@tiptap/core';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueRead } from '../../types/Api';
import IssueBody from './IssueBody';

const updateIssue = vi.fn<(id: string, body: unknown) => Promise<IssueRead>>();

vi.mock('../../api/issues', () => ({
  updateIssue: (_w: string, id: string, body: unknown) => updateIssue(id, body),
}));

/** Settles the upload the test is holding open. */
let finishUpload: (() => void) | null = null;

const uploadAttachment =
  vi.fn<
    (
      file: File,
      onProgress?: (sent: { loaded: number; total: number }) => void
    ) => Promise<{ attachment_id: string }>
  >();

vi.mock('../../api/discussion', () => ({
  uploadAttachment: (
    _w: string,
    _i: string,
    file: File,
    _t: string | undefined,
    onProgress?: (sent: { loaded: number; total: number }) => void
  ) => uploadAttachment(file, onProgress),
}));

/** The issue under edit, with a Markdown body that holds a link. */
const issue: IssueRead = {
  id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: 'ENG-1',
  number: 1,
  title: 'Cache the token',
  body: 'Some **markdown** and [a link](https://example.com)',
  status_id: 'st-1',
  priority: 'high',
  assignee_id: null,
  label_ids: [],
  estimate: null,
  start_date: null,
  due_date: null,
  parent_id: null,
  cycle_id: null,
  project_id: null,
  progress: { total: 0, completed: 0 },
  created_by: 'user-1',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
};

/** Renders the body with spies for the save and the attach. */
const renderBody = (canEdit = true) => {
  const onSaved = vi.fn();
  const onDropFiles = vi.fn();
  render(
    <IssueBody
      workspaceId="ws-1"
      issue={issue}
      canEdit={canEdit}
      onSaved={onSaved}
      onDropFiles={onDropFiles}
    />
  );
  return { onSaved, onDropFiles };
};

/** How long the lazily loaded editor may take to arrive on a busy runner. */
const EDITOR_LOAD_MS = 10_000;

/** The description surface once the lazy editor has arrived. */
const findSurface = async (): Promise<HTMLElement> =>
  screen.findByRole(
    'textbox',
    { name: 'Description' },
    { timeout: EDITOR_LOAD_MS }
  );

/** The Tiptap editor behind a surface. */
const editorOf = (surface: HTMLElement): Editor =>
  (surface as HTMLElement & { editor: Editor }).editor;

/**
 * Puts the caret at the end of the surface and appends text. The DOM focus is
 * explicit because Tiptap defers its own focus to the next animation frame.
 */
const typeAtEnd = (surface: HTMLElement, text: string): void => {
  act(() => {
    surface.focus();
    editorOf(surface)
      .chain()
      .setTextSelection(editorOf(surface).state.doc.content.size - 1)
      .insertContent(text)
      .run();
  });
};

beforeEach(() => {
  uploadAttachment.mockReset();
  finishUpload = null;
  updateIssue.mockReset();
  updateIssue.mockImplementation((_id, body) =>
    Promise.resolve({ ...issue, ...(body as Partial<IssueRead>) })
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the description', () => {
  it('is the formatted document with no pencil or edit mode', async () => {
    renderBody();

    const surface = await findSurface();

    expect(surface).toHaveAttribute('contenteditable', 'true');
    expect(surface.querySelector('strong')).toHaveTextContent('markdown');
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
  });

  it('saves the Markdown when focus leaves it', async () => {
    const { onSaved } = renderBody();
    const surface = await findSurface();

    typeAtEnd(surface, '!');
    act(() => {
      fireEvent.blur(surface);
    });

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith('iss-1', {
        body: `${issue.body ?? ''}!`,
      });
    });
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
    });
  });

  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['Cmd', { metaKey: true }],
  ])('saves on %s Enter', async (_name, modifier) => {
    renderBody();
    const surface = await findSurface();

    typeAtEnd(surface, '!');
    act(() => {
      fireEvent.keyDown(surface, { key: 'Enter', ...modifier });
    });

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith('iss-1', {
        body: `${issue.body ?? ''}!`,
      });
    });
  });

  it('puts the saved text back on Escape without saving', async () => {
    renderBody();
    const surface = await findSurface();
    const editor = editorOf(surface);

    typeAtEnd(surface, ' more');
    act(() => {
      fireEvent.keyDown(surface, { key: 'Escape' });
    });
    act(() => {
      fireEvent.blur(surface);
    });

    expect(editor.getText()).not.toContain('more');
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it('saves nothing when the document is unchanged', async () => {
    renderBody();
    const surface = await findSurface();

    act(() => {
      surface.focus();
    });
    act(() => {
      fireEvent.keyDown(surface, { key: 'Enter', ctrlKey: true });
      fireEvent.blur(surface);
    });

    expect(updateIssue).not.toHaveBeenCalled();
  });

  it('follows a link clicked while not editing', async () => {
    const open = vi.spyOn(globalThis, 'open').mockReturnValue(null);
    renderBody();
    await findSurface();

    fireEvent.click(screen.getByRole('link', { name: 'a link' }));

    expect(open).toHaveBeenCalledWith(
      'https://example.com',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('uploads a pasted image behind a progress bar, then embeds it', async () => {
    uploadAttachment.mockImplementation((_file, onProgress) => {
      onProgress?.({ loaded: 50, total: 100 });
      return new Promise((resolve) => {
        finishUpload = () => {
          resolve({ attachment_id: 'att-9' });
        };
      });
    });
    const { onDropFiles } = renderBody();
    const surface = await findSurface();
    const file = new File(['png'], 'shot.png', { type: 'image/png' });

    fireEvent.paste(surface, {
      clipboardData: {
        files: [file],
        items: [{ kind: 'file', getAsFile: () => file }],
        types: ['Files'],
        getData: () => '',
      },
    });

    const bar = await screen.findByRole('progressbar', {
      name: 'Uploading shot.png',
    });
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(onDropFiles).not.toHaveBeenCalled();

    await act(async () => {
      finishUpload?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(editorOf(surface).getMarkdown()).toContain(
        '![shot.png](/api/workspaces/ws-1/attachments/att-9/content?issue_id=iss-1)'
      );
    });
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('lands any other file as a link to it', async () => {
    uploadAttachment.mockResolvedValue({ attachment_id: 'att-3' });
    renderBody();
    const surface = await findSurface();
    const file = new File(['pdf'], 'trace.pdf', { type: 'application/pdf' });

    fireEvent.paste(surface, {
      clipboardData: {
        files: [file],
        items: [{ kind: 'file', getAsFile: () => file }],
        types: ['Files'],
        getData: () => '',
      },
    });

    await waitFor(() => {
      expect(editorOf(surface).getMarkdown()).toContain(
        '[trace.pdf](/api/workspaces/ws-1/attachments/att-3/content?issue_id=iss-1)'
      );
    });
  });

  it('refuses a file type it cannot store without uploading it', async () => {
    renderBody();
    const surface = await findSurface();
    const file = new File(['x'], 'tool.exe', {
      type: 'application/x-msdownload',
    });

    fireEvent.paste(surface, {
      clipboardData: {
        files: [file],
        items: [{ kind: 'file', getAsFile: () => file }],
        types: ['Files'],
        getData: () => '',
      },
    });

    await Promise.resolve();
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(editorOf(surface).getText()).not.toContain('tool.exe');
  });

  it('is read only for a reader', async () => {
    renderBody(false);
    const surface = await findSurface();

    expect(surface).toHaveAttribute('contenteditable', 'false');
    expect(screen.queryByRole('textbox', { name: 'Issue title' })).toBeNull();
    expect(
      screen.getByRole('heading', { name: 'Cache the token' })
    ).toBeInTheDocument();
  });
});
