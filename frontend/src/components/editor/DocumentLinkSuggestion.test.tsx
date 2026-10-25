/**
 * The `[[` document picker. Two opening brackets open a picker of the
 * workspace's documents, searching by title; picking one writes the same
 * document link the `#` picker writes, and the last row creates a document
 * under the page's project or initiative and links it. Escape and a closing
 * bracket close it and keep the text, and Ctrl or Cmd Enter also opens the
 * document in a new tab.
 */

import type { Editor } from '@tiptap/core';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument, listWorkspaceDocuments } from '../../api/documents';
import {
  DocumentLinkContext,
  type DocumentLinkParent,
} from '../../contexts/DocumentLinkContext';
import {
  WorkspaceContext,
  type WorkspaceContextType,
} from '../../contexts/WorkspaceContextDefinition';
import { refreshDocumentLists } from '../../hooks/useDocuments';
import type { DocumentRead, DocumentSummaryRead } from '../../types/Api';
import { documentLinkQuery } from './DocumentLinkSuggestion';
import { RichMarkdownEditor } from './RichMarkdownEditor';

vi.mock('../../api/documents', () => ({
  listWorkspaceDocuments: vi.fn(),
  createDocument: vi.fn(),
}));

vi.mock('../../hooks/useDocuments', () => ({
  refreshDocumentLists: vi.fn(),
}));

const listMock = vi.mocked(listWorkspaceDocuments);
const createMock = vi.mocked(createDocument);

/** A document summary with the given id and title. */
const doc = (id: string, title: string): DocumentSummaryRead => ({
  document_id: id,
  workspace_id: 'ws-1',
  parent_kind: 'project',
  parent_id: 'p-1',
  parent_name: 'Launch',
  title,
  author_id: 'u-1',
  updated_by: 'u-1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  can_edit: true,
  can_delete: true,
});

const workspace: WorkspaceContextType = {
  workspace: {
    id: 'ws-1',
    name: 'Mine',
    slug: 'mine',
    plan: 'free',
    created_at: '2026-09-17T00:00:00Z',
    role: 'member',
  },
  isLoading: false,
  notFound: false,
  error: null,
  refresh: () => Promise.resolve(),
};

/** The address a document link points at in this test window. */
const href = (id: string): string =>
  `${window.location.origin}/w/mine/documents/${id}`;

/** The Tiptap editor behind a surface. */
const editorOf = (surface: HTMLElement): Editor =>
  (surface as HTMLElement & { editor: Editor }).editor;

/** Feeds text through the editor's own text input path, as typing does. */
const typeText = (editor: Editor, text: string): void => {
  act(() => {
    for (const char of text) {
      const { from, to } = editor.state.selection;
      const handled = editor.view.someProp('handleTextInput', (handle) =>
        handle(editor.view, from, to, char, () =>
          editor.state.tr.insertText(char)
        )
      );
      if (handled !== true) {
        editor.view.dispatch(editor.state.tr.insertText(char, from, to));
      }
    }
  });
};

/** Renders an editable surface in a workspace, under an optional parent. */
const renderSurface = (
  parent: DocumentLinkParent | null = { kind: 'project', id: 'p-1' }
): {
  surface: HTMLElement;
  editor: Editor;
  onChange: ReturnType<typeof vi.fn>;
} => {
  const onChange = vi.fn();
  render(
    <WorkspaceContext.Provider value={workspace}>
      <DocumentLinkContext.Provider value={parent}>
        <RichMarkdownEditor
          value=""
          editable
          ariaLabel="Description"
          onCommit={() => true}
          onChange={onChange}
        />
      </DocumentLinkContext.Provider>
    </WorkspaceContext.Provider>
  );
  const surface = screen.getByRole('textbox', { name: 'Description' });
  const editor = editorOf(surface);
  act(() => {
    editor.commands.focus();
  });
  return { surface, editor, onChange };
};

/** The open document picker, or null. */
const menu = (): HTMLElement | null =>
  screen.queryByRole('listbox', { name: 'Link a document' });

/** The text of each row of the open picker. */
const rows = (): string[] => {
  const open = menu();
  if (open === null) return [];
  return within(open)
    .queryAllByRole('option')
    .map((option) => option.textContent);
};

/** Presses a key on the surface. */
const press = (
  surface: HTMLElement,
  key: string,
  modifiers: { ctrlKey?: boolean } = {}
): void => {
  act(() => {
    fireEvent.keyDown(surface, { key, ...modifiers });
  });
};

/** The last Markdown the surface reported. */
const lastMarkdown = (onChange: ReturnType<typeof vi.fn>): string =>
  String(onChange.mock.calls.at(-1)?.[0] ?? '');

beforeEach(() => {
  listMock.mockResolvedValue([
    doc('d-1', 'Release plan'),
    doc('d-2', 'Retro notes'),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
  listMock.mockReset();
  createMock.mockReset();
  vi.mocked(refreshDocumentLists).mockReset();
});

describe('the trigger', () => {
  it('opens on two brackets and reads the title after them', () => {
    expect(documentLinkQuery('[')).toBeNull();
    expect(documentLinkQuery('[[')).toEqual({ start: 0, query: '' });
    expect(documentLinkQuery('see [[Release pl')).toEqual({
      start: 4,
      query: 'Release pl',
    });
  });

  it('closes on a closing bracket or a line break', () => {
    expect(documentLinkQuery('[[Release]')).toBeNull();
    expect(documentLinkQuery('[[Release]]')).toBeNull();
    expect(documentLinkQuery('[[a\nb')).toBeNull();
  });
});

describe('the document picker', () => {
  it('lists recent documents, filters by title and ends with a create row', async () => {
    const { editor } = renderSurface();
    typeText(editor, '[[');
    await waitFor(() => {
      expect(rows()).toHaveLength(3);
    });
    expect(rows()[0]).toContain('Release plan');
    expect(rows()[2]).toContain('Create document:');
    expect(rows()[2]).toContain('Untitled');
    typeText(editor, 'retro');
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toContain('Retro notes');
    expect(rows()[1]).toContain('retro');
  });

  it('links the highlighted document on Enter', async () => {
    const { surface, editor, onChange } = renderSurface();
    typeText(editor, 'See [[re');
    await waitFor(() => {
      expect(rows()).toHaveLength(3);
    });
    press(surface, 'ArrowDown');
    press(surface, 'Enter');
    expect(menu()).toBeNull();
    expect(lastMarkdown(onChange)).toContain(
      `See [Retro notes](${href('d-2')})`
    );
  });

  it('creates a document under the parent and links it', async () => {
    const created = {
      ...doc('d-9', 'Launch checklist'),
      body: '',
      mentions: [],
    } as DocumentRead;
    createMock.mockResolvedValue(created);
    const { surface, editor, onChange } = renderSurface();
    typeText(editor, '[[Launch checklist');
    await waitFor(() => {
      expect(rows().at(-1)).toContain('Launch checklist');
    });
    press(surface, 'ArrowUp');
    press(surface, 'Enter');
    expect(menu()).toBeNull();
    expect(createMock).toHaveBeenCalledWith('ws-1', 'project', 'p-1', {
      title: 'Launch checklist',
    });
    await waitFor(() => {
      expect(lastMarkdown(onChange)).toContain(
        `[Launch checklist](${href('d-9')})`
      );
    });
    expect(refreshDocumentLists).toHaveBeenCalledWith('ws-1', 'project', 'p-1');
  });

  it('opens the document in a new tab only on Ctrl Enter', async () => {
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    const { surface, editor } = renderSurface();
    typeText(editor, '[[release');
    await waitFor(() => {
      expect(rows()).toHaveLength(2);
    });
    press(surface, 'Enter');
    expect(opened).not.toHaveBeenCalled();
    typeText(editor, '[[release');
    await waitFor(() => {
      expect(rows()).toHaveLength(2);
    });
    press(surface, 'Enter', { ctrlKey: true });
    expect(opened).toHaveBeenCalledWith(
      href('d-1'),
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('closes on Escape and on closing brackets and keeps the text', async () => {
    const { surface, editor } = renderSurface();
    typeText(editor, '[[rel');
    await waitFor(() => {
      expect(menu()).not.toBeNull();
    });
    press(surface, 'Escape');
    expect(menu()).toBeNull();
    typeText(editor, 'ease');
    expect(menu()).toBeNull();
    typeText(editor, ' [[x]]');
    expect(menu()).toBeNull();
    expect(editor.state.doc.textContent).toBe('[[release [[x]]');
  });

  it('offers no create row without a parent', async () => {
    const { editor } = renderSurface(null);
    typeText(editor, '[[zzz');
    await waitFor(() => {
      expect(menu()?.textContent).toBe('No matching documents');
    });
    expect(rows()).toEqual([]);
  });
});
