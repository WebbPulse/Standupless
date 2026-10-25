/**
 * The document routes: Markdown pages under a project, an initiative or a
 * team. A
 * document is listed and created through its parent and reached afterwards by
 * its own id, so a link to one survives a rename and a move of the page.
 */

import apiClient from './client';
import type {
  DocumentCreate,
  DocumentListRead,
  DocumentParentKind,
  DocumentPatch,
  DocumentRead,
  DocumentSummaryRead,
  DocumentVersionListRead,
  DocumentVersionRead,
} from '../types/Api';

const signalOptions = (
  signal?: AbortSignal
): { signal: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };

const rows = (body: DocumentListRead | undefined): DocumentSummaryRead[] =>
  Array.isArray(body?.documents) ? body.documents : [];

/** The route one project's documents are listed and created on. */
export const projectDocumentsPath = (
  workspaceId: string,
  projectId: string
): string => `/workspaces/${workspaceId}/projects/${projectId}/documents`;

/** The route one initiative's documents are listed and created on. */
export const initiativeDocumentsPath = (
  workspaceId: string,
  initiativeId: string
): string => `/workspaces/${workspaceId}/initiatives/${initiativeId}/documents`;

/** The route one team's documents are listed and created on. */
export const teamDocumentsPath = (
  workspaceId: string,
  teamId: string
): string => `/workspaces/${workspaceId}/teams/${teamId}/documents`;

/** The route one parent's documents are listed and created on. */
export const parentDocumentsPath = (
  workspaceId: string,
  parentKind: DocumentParentKind,
  parentId: string
): string => {
  if (parentKind === 'project')
    return projectDocumentsPath(workspaceId, parentId);
  if (parentKind === 'team') return teamDocumentsPath(workspaceId, parentId);
  return initiativeDocumentsPath(workspaceId, parentId);
};

/** The route every readable document is listed on. */
export const workspaceDocumentsPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/documents`;

/** The route one document is read, edited and deleted through. */
export const documentApiPath = (
  workspaceId: string,
  documentId: string
): string => `${workspaceDocumentsPath(workspaceId)}/${documentId}`;

/** The route one document's earlier versions are listed on. */
export const documentVersionsPath = (
  workspaceId: string,
  documentId: string
): string => `${documentApiPath(workspaceId, documentId)}/versions`;

/** The route the documents mentioning one issue are listed on. */
export const issueDocumentsPath = (
  workspaceId: string,
  issueId: string
): string => `/workspaces/${workspaceId}/issues/${issueId}/documents`;

/** Lists one parent's documents, most recently edited first. */
export const listDocuments = async (
  workspaceId: string,
  parentKind: DocumentParentKind,
  parentId: string,
  signal?: AbortSignal
): Promise<DocumentSummaryRead[]> => {
  const response = await apiClient.get<DocumentListRead>(
    parentDocumentsPath(workspaceId, parentKind, parentId),
    signalOptions(signal)
  );
  return rows(response.data);
};

/** Lists every document the caller can read, for the command palette. */
export const listWorkspaceDocuments = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<DocumentSummaryRead[]> => {
  const response = await apiClient.get<DocumentListRead>(
    workspaceDocumentsPath(workspaceId),
    signalOptions(signal)
  );
  return rows(response.data);
};

/** Lists the readable documents that mention one issue. */
export const listIssueDocuments = async (
  workspaceId: string,
  issueId: string,
  signal?: AbortSignal
): Promise<DocumentSummaryRead[]> => {
  const response = await apiClient.get<DocumentListRead>(
    issueDocumentsPath(workspaceId, issueId),
    signalOptions(signal)
  );
  return rows(response.data);
};

/** Writes a new document under a project, an initiative or a team. */
export const createDocument = async (
  workspaceId: string,
  parentKind: DocumentParentKind,
  parentId: string,
  body: DocumentCreate
): Promise<DocumentRead> => {
  const response = await apiClient.post<DocumentRead>(
    parentDocumentsPath(workspaceId, parentKind, parentId),
    body
  );
  return response.data;
};

/** Reads one document with its body. */
export const getDocument = async (
  workspaceId: string,
  documentId: string,
  signal?: AbortSignal
): Promise<DocumentRead> => {
  const response = await apiClient.get<DocumentRead>(
    documentApiPath(workspaceId, documentId),
    signalOptions(signal)
  );
  return response.data;
};

/** Renames, rewrites, restyles or moves a document; a stale `base_updated_at` is a 409. */
export const updateDocument = async (
  workspaceId: string,
  documentId: string,
  body: DocumentPatch
): Promise<DocumentRead> => {
  const response = await apiClient.patch<DocumentRead>(
    documentApiPath(workspaceId, documentId),
    body
  );
  return response.data;
};

/** Deletes a document with its version history. */
export const deleteDocument = async (
  workspaceId: string,
  documentId: string
): Promise<void> => {
  await apiClient.delete<void>(documentApiPath(workspaceId, documentId));
};

/** Lists a document's kept versions, newest first. */
export const listDocumentVersions = async (
  workspaceId: string,
  documentId: string,
  signal?: AbortSignal
): Promise<DocumentVersionRead[]> => {
  const response = await apiClient.get<DocumentVersionListRead>(
    documentVersionsPath(workspaceId, documentId),
    signalOptions(signal)
  );
  const body = response.data;
  return Array.isArray(body?.versions) ? body.versions : [];
};
