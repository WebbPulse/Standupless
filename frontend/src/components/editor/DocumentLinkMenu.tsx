/**
 * The `[[` document picker a rich surface draws inside a workspace. It reads
 * the workspace's documents when it opens, lists the ones whose title matches
 * what follows the brackets, recent ones first, and ends with a row that
 * creates a document from the typed title under the project or initiative the
 * page provides. Either pick writes the same document link the `#` picker
 * writes, so the Markdown round trip is unchanged.
 *
 * A created document's title goes in at once as plain text and gains its link
 * when the write answers. Ctrl or Cmd Enter also opens the document in a new
 * tab; a plain Enter keeps the writer where they are.
 */

import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import React, { useContext, useEffect, useRef, useState } from 'react';
import { createDocument, listWorkspaceDocuments } from '../../api/documents';
import {
  DocumentLinkContext,
  type DocumentLinkParent,
} from '../../contexts/DocumentLinkContext';
import { WorkspaceContext } from '../../contexts/WorkspaceContextDefinition';
import { refreshDocumentLists } from '../../hooks/useDocuments';
import {
  documentLinkMatches,
  documentLinkTitle,
} from '../../lib/documentLinks';
import { errorMessage } from '../../lib/errors';
import { isFeatureOn } from '../../lib/features';
import { currentOrigin, referenceHref } from '../../lib/references';
import { showErrorToast } from '../../lib/toast';
import type { DocumentSummaryRead } from '../../types/Api';
import {
  actOnDocumentLink,
  closedDocumentLink,
  documentLinkKey,
  registerDocumentLinkPicker,
  type DocumentLinkState,
} from './DocumentLinkSuggestion';
import { ReferenceMenu } from './ReferenceMenu';

/** The width the menu is drawn at, for keeping it inside the surface. */
const MENU_WIDTH = 320;

/** The picker's state with where its menu opens. */
interface Placed {
  held: DocumentLinkState;
  top: number;
  left: number;
}

/** The workspace's documents as the picker last read them. */
interface Loaded {
  rows: DocumentSummaryRead[];
  loading: boolean;
}

/** Where the menu opens under a position, relative to the surface. */
const placeAt = (
  editor: Editor,
  position: number
): { top: number; left: number } => {
  try {
    const dom = editor.view.dom;
    const host = (dom.offsetParent ?? dom.parentElement) as HTMLElement | null;
    if (host === null) return { top: 0, left: 0 };
    const box = host.getBoundingClientRect();
    const caret = editor.view.coordsAtPos(position);
    return {
      top: caret.bottom - box.top + 4,
      left: Math.max(
        0,
        Math.min(caret.left - box.left, box.width - MENU_WIDTH)
      ),
    };
  } catch {
    return { top: 0, left: 0 };
  }
};

/** Writes a document link over a range, followed by a space. */
const insertLink = (
  editor: Editor,
  range: { from: number; to: number },
  title: string,
  href: string
): void => {
  editor
    .chain()
    .focus()
    .insertContentAt(range, [
      { type: 'text', text: title, marks: [{ type: 'link', attrs: { href } }] },
      { type: 'text', text: ' ' },
    ])
    .run();
};

/** Opens a page in a new tab without handing it this window. */
const openInNewTab = (href: string): void => {
  globalThis.open(href, '_blank', 'noopener,noreferrer');
};

/**
 * Writes a title in place of the typed query, creates the document, and links
 * the title once the write answers. The title's range follows every edit made
 * while the write is in flight.
 */
const createAndLink = (
  editor: Editor,
  workspace: { id: string; slug: string },
  parent: DocumentLinkParent,
  range: { from: number; to: number },
  title: string,
  newTab: boolean
): void => {
  const tab = newTab ? globalThis.open('', '_blank') : null;
  editor
    .chain()
    .focus()
    .insertContentAt(range, [
      { type: 'text', text: title },
      { type: 'text', text: ' ' },
    ])
    .run();
  let span = { from: range.from, to: range.from + title.length };
  const follow = ({ transaction }: { transaction: Transaction }): void => {
    span = {
      from: transaction.mapping.map(span.from, 1),
      to: transaction.mapping.map(span.to, -1),
    };
  };
  editor.on('transaction', follow);
  createDocument(workspace.id, parent.kind, parent.id, { title })
    .then((created) => {
      editor.off('transaction', follow);
      const href = referenceHref(currentOrigin(), workspace.slug, {
        kind: 'document',
        id: created.document_id,
        title: created.title,
        parentName: created.parent_name,
      });
      refreshDocumentLists(workspace.id, parent.kind, parent.id);
      if (tab !== null) {
        tab.opener = null;
        tab.location.href = href;
      }
      if (editor.isDestroyed) return;
      const link = editor.schema.marks['link'];
      if (
        link === undefined ||
        span.to <= span.from ||
        editor.state.doc.textBetween(span.from, span.to) !== title
      ) {
        return;
      }
      editor.view.dispatch(
        editor.state.tr.addMark(span.from, span.to, link.create({ href }))
      );
    })
    .catch((error: unknown) => {
      editor.off('transaction', follow);
      tab?.close();
      showErrorToast(errorMessage(error, 'Could not create the document.'));
    });
};

/** Reads the workspace's documents each time the picker opens. */
const useOpenDocuments = (workspaceId: string, open: boolean): Loaded => {
  const [loaded, setLoaded] = useState<Loaded>({ rows: [], loading: false });
  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    setLoaded((previous) => ({ rows: previous.rows, loading: true }));
    listWorkspaceDocuments(workspaceId, controller.signal)
      .then((rows) => {
        setLoaded({ rows, loading: false });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setLoaded((previous) => ({ rows: previous.rows, loading: false }));
      });
    return () => {
      controller.abort();
    };
  }, [workspaceId, open]);
  return loaded;
};

/** The picker for one editor in one workspace. */
const WorkspaceDocumentLinkMenu: React.FC<{
  editor: Editor;
  workspace: { id: string; slug: string };
}> = ({ editor, workspace }) => {
  const parent = useContext(DocumentLinkContext);
  const [placed, setPlaced] = useState<Placed>(() => ({
    held: documentLinkKey.getState(editor.state) ?? closedDocumentLink,
    top: 0,
    left: 0,
  }));

  useEffect(() => {
    const read = (): void => {
      const held = documentLinkKey.getState(editor.state) ?? closedDocumentLink;
      setPlaced((previous) => {
        if (previous.held === held) return previous;
        if (!held.open) return { held, top: 0, left: 0 };
        if (previous.held.open && previous.held.from === held.from) {
          return { ...previous, held };
        }
        return { held, ...placeAt(editor, held.from) };
      });
    };
    editor.on('transaction', read);
    return () => {
      editor.off('transaction', read);
    };
  }, [editor]);

  const { held } = placed;
  const documents = useOpenDocuments(workspace.id, held.open);
  const items = held.open
    ? documentLinkMatches(documents.rows, held.query)
    : [];
  const createTitle = parent === null ? null : documentLinkTitle(held.query);
  const count = items.length + (createTitle === null ? 0 : 1);
  const highlight = Math.min(held.highlight, Math.max(0, count - 1));

  const choose = (index: number, newTab: boolean): void => {
    if (!held.open) return;
    const range = { from: held.from, to: held.to };
    const item = items[index];
    if (item !== undefined) {
      const href = referenceHref(currentOrigin(), workspace.slug, item);
      insertLink(editor, range, item.title, href);
      if (newTab) openInNewTab(href);
      return;
    }
    if (createTitle === null || parent === null || index !== items.length) {
      return;
    }
    createAndLink(editor, workspace, parent, range, createTitle, newTab);
  };

  const latest = useRef({ count, choose });
  latest.current = { count, choose };

  useEffect(
    () =>
      registerDocumentLinkPicker(editor, {
        count: () => latest.current.count,
        choose: (index, newTab) => {
          latest.current.choose(index, newTab);
        },
      }),
    [editor]
  );

  if (!held.open || !editor.isEditable) return null;
  return (
    <ReferenceMenu
      ariaLabel="Link a document"
      items={items}
      highlight={highlight}
      loading={documents.loading}
      searchable
      top={placed.top}
      left={placed.left}
      hint={documents.loading ? 'Loading documents' : 'No matching documents'}
      createTitle={createTitle}
      onChoose={(item) => {
        choose(
          items.findIndex((row) => row.id === item.id),
          false
        );
      }}
      onCreate={() => {
        choose(items.length, false);
      }}
      onHighlight={(index) => {
        actOnDocumentLink(editor.view, { type: 'highlight', index });
      }}
    />
  );
};

/** The `[[` document picker, drawn only inside a workspace that has documents turned on. */
export const DocumentLinkMenu: React.FC<{ editor: Editor }> = ({ editor }) => {
  const workspace = useContext(WorkspaceContext)?.workspace ?? null;
  if (workspace === null || !isFeatureOn(workspace, 'documents')) return null;
  return (
    <WorkspaceDocumentLinkMenu
      editor={editor}
      workspace={{ id: workspace.id, slug: workspace.slug }}
    />
  );
};

export default DocumentLinkMenu;
