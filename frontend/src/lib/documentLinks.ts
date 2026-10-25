/**
 * The `[[` document picker's list. Documents arrive most recently edited
 * first, so an empty query shows the recent ones; a typed query keeps the
 * documents whose title holds every word, titles that start with it first.
 */

import type { DocumentSummaryRead } from '../types/Api';
import type { DocumentReference } from './references';

/** How many documents the picker lists. */
export const DOCUMENT_LINK_LIMIT = 8;

/** The title a document created from an empty query gets. */
export const UNTITLED_DOCUMENT = 'Untitled';

/** The longest title the picker creates a document under. */
const TITLE_MAX = 120;

/** One document as the picker offers it. */
const documentItem = (document: DocumentSummaryRead): DocumentReference => ({
  kind: 'document',
  id: document.document_id,
  title: document.title,
  parentName: document.parent_name,
});

/** The documents a query matches, best first, capped at the limit. */
export const documentLinkMatches = (
  documents: readonly DocumentSummaryRead[],
  query: string,
  limit: number = DOCUMENT_LINK_LIMIT
): DocumentReference[] => {
  const typed = query.trim().toLowerCase();
  const terms = typed.split(/\s+/).filter((term) => term !== '');
  const hits = documents.filter((document) => {
    const title = document.title.toLowerCase();
    return terms.every((term) => title.includes(term));
  });
  const leading = hits.filter((document) =>
    document.title.toLowerCase().startsWith(typed)
  );
  const rest = hits.filter(
    (document) => !document.title.toLowerCase().startsWith(typed)
  );
  return [...leading, ...rest].slice(0, limit).map(documentItem);
};

/** The title the create row would give a new document. */
export const documentLinkTitle = (query: string): string => {
  const typed = query.trim().replace(/\s+/g, ' ').slice(0, TITLE_MAX).trim();
  return typed === '' ? UNTITLED_DOCUMENT : typed;
};
