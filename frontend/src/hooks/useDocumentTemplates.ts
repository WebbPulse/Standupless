/**
 * The document templates a project or initiative offers, read on a slow poll.
 * The new document menu and the update composer both read this one list, so
 * a template added in settings shows in either without a reload.
 */

import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { listParentDocumentTemplates } from '../api/templates';
import { parentDocumentTemplatesKey } from '../lib/queryKeys';
import type { TemplateRead } from '../types/Api';

/** How often the offer re-reads; templates change rarely. */
const POLL_MS = 60000;

/** What {@link useDocumentTemplates} hands back. */
export interface DocumentTemplateOffer {
  templates: TemplateRead[];
  /** The template a new document starts from, when the parent sets one. */
  defaultDocument: TemplateRead | null;
  /** The template the update composer opens with, when the parent sets one. */
  defaultUpdate: TemplateRead | null;
  isLoading: boolean;
}

/** Reads the document templates one project or initiative offers. */
export const useDocumentTemplates = (
  workspaceId: string,
  parentKind: 'project' | 'initiative',
  parentId: string,
  enabled = true
): DocumentTemplateOffer => {
  const auth = useQueryAuth();
  const { data, isLoading } = usePolledQuery(
    ({ signal }) =>
      listParentDocumentTemplates(workspaceId, parentKind, parentId, signal),
    {
      intervalMs: POLL_MS,
      enabled: enabled && workspaceId !== '' && parentId !== '',
      queryKey: parentDocumentTemplatesKey(parentKind, parentId),
      auth,
    }
  );
  const templates = data?.templates ?? [];
  const find = (id: string | null | undefined): TemplateRead | null =>
    templates.find((template) => template.id === id) ?? null;
  return {
    templates,
    defaultDocument: find(data?.default_document_template_id),
    defaultUpdate: find(data?.default_update_template_id),
    isLoading,
  };
};

export default useDocumentTemplates;
