/**
 * Where a document created from the `[[` picker is filed: the project or
 * initiative the surface being edited belongs to. A page provides it around
 * its editors, and a surface with none offers only existing documents.
 */

import { createContext } from 'react';
import type { DocumentParentKind } from '../types/Api';

/** The parent a new document is created under. */
export interface DocumentLinkParent {
  kind: DocumentParentKind;
  id: string;
}

/** Carries the parent new documents land under to the editors below it. */
export const DocumentLinkContext = createContext<DocumentLinkParent | null>(
  null
);

/** The parent an issue's documents land under: its project, when it has one. */
export const issueDocumentParent = (
  projectId: string | null | undefined
): DocumentLinkParent | null =>
  projectId === null || projectId === undefined || projectId === ''
    ? null
    : { kind: 'project', id: projectId };
