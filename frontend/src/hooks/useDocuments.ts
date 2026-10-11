/**
 * One project's or initiative's documents, read on a poll. Writes go straight
 * to the server and then refresh every list a document shows in, so the
 * section, the command palette and the issue backlinks agree after a change.
 */

import { useCallback } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import {
  createDocument,
  deleteDocument,
  listDocuments,
  updateDocument,
} from '../api/documents';
import { errorMessage } from '../lib/errors';
import {
  documentKey,
  documentsKey,
  workspaceDocumentsKey,
} from '../lib/queryKeys';
import { showErrorToast } from '../lib/toast';
import type {
  DocumentParentKind,
  DocumentRead,
  DocumentSummaryRead,
} from '../types/Api';

/** How often the list re-reads, which is how another editor's rename shows. */
const POLL_MS = 30000;

/** What {@link useDocuments} hands back. */
export interface ParentDocuments {
  documents: DocumentSummaryRead[];
  isLoading: boolean;
  error: unknown;
  /** Writes a new document and answers it, or null when the write failed. */
  create: (title: string) => Promise<DocumentRead | null>;
  /** Renames one document. Resolves false when the write failed. */
  rename: (documentId: string, title: string) => Promise<boolean>;
  /** Deletes one document. Resolves false when the write failed. */
  remove: (documentId: string) => Promise<boolean>;
}

/** Refreshes every list and page one document change can show in. */
export const refreshDocumentLists = (
  workspaceId: string,
  parentKind: DocumentParentKind,
  parentId: string,
  documentId?: string
): void => {
  const keys = [
    documentsKey(workspaceId, parentKind, parentId),
    workspaceDocumentsKey(workspaceId),
  ];
  if (documentId !== undefined) keys.push(documentKey(workspaceId, documentId));
  invalidateQueries(keys);
};

/** Reads and writes the documents under one project or initiative. */
export const useDocuments = (
  workspaceId: string,
  parentKind: DocumentParentKind,
  parentId: string,
  enabled = true
): ParentDocuments => {
  const auth = useQueryAuth();
  const { data, isLoading, error } = usePolledQuery(
    ({ signal }) => listDocuments(workspaceId, parentKind, parentId, signal),
    {
      intervalMs: POLL_MS,
      enabled: enabled && workspaceId !== '' && parentId !== '',
      queryKey: documentsKey(workspaceId, parentKind, parentId),
      auth,
    }
  );

  const create = useCallback(
    async (title: string): Promise<DocumentRead | null> => {
      try {
        const made = await createDocument(workspaceId, parentKind, parentId, {
          title,
        });
        refreshDocumentLists(workspaceId, parentKind, parentId);
        return made;
      } catch (problem) {
        showErrorToast(
          errorMessage(problem, 'Could not create that document.')
        );
        return null;
      }
    },
    [workspaceId, parentKind, parentId]
  );

  const rename = useCallback(
    async (documentId: string, title: string): Promise<boolean> => {
      try {
        await updateDocument(workspaceId, documentId, { title });
        refreshDocumentLists(workspaceId, parentKind, parentId, documentId);
        return true;
      } catch (problem) {
        showErrorToast(
          errorMessage(problem, 'Could not rename that document.')
        );
        return false;
      }
    },
    [workspaceId, parentKind, parentId]
  );

  const remove = useCallback(
    async (documentId: string): Promise<boolean> => {
      try {
        await deleteDocument(workspaceId, documentId);
        refreshDocumentLists(workspaceId, parentKind, parentId);
        return true;
      } catch (problem) {
        showErrorToast(
          errorMessage(problem, 'Could not delete that document.')
        );
        return false;
      }
    },
    [workspaceId, parentKind, parentId]
  );

  return {
    documents: data ?? [],
    isLoading: isLoading && data === null,
    error,
    create,
    rename,
    remove,
  };
};

export default useDocuments;
