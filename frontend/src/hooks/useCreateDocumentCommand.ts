/**
 * Offers "Create document" in the command palette on a project or an
 * initiative page, under the page's own group heading. It creates the document
 * untitled and opens it, the same as the plus on the Documents section, but
 * from any tab of the page, since the section only shows on the overview.
 * When the parent sets a default document template, the new document starts
 * from it.
 *
 * It registers a `'page'` shortcut with no key of its own, which is how the
 * palette learns of an action without declaring it.
 */

import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { documentPath } from '../lib/paths';
import type { DocumentParentKind } from '../types/Api';
import useDocumentTemplates from './useDocumentTemplates';
import useDocuments from './useDocuments';
import { useShortcut } from './useShortcuts';

/** The title a new document starts with until it is named. */
const UNTITLED = 'Untitled';

/** What {@link useCreateDocumentCommand} needs. */
export interface CreateDocumentCommandOptions {
  workspaceId: string;
  slug: string;
  parentKind: DocumentParentKind;
  parentId: string;
  /** The palette heading the command sits under, such as "Project". */
  group: string;
  /** Whether the caller may write documents under the parent. */
  enabled: boolean;
}

/** Registers the palette's "Create document" command for one parent. */
export const useCreateDocumentCommand = ({
  workspaceId,
  slug,
  parentKind,
  parentId,
  group,
  enabled,
}: CreateDocumentCommandOptions): void => {
  const navigate = useNavigate();
  const { create } = useDocuments(workspaceId, parentKind, parentId, false);
  const { defaultDocument } = useDocumentTemplates(
    workspaceId,
    parentKind,
    parentId,
    enabled
  );
  const busy = useRef(false);

  useShortcut({
    keys: '',
    label: 'Create document',
    scope: 'page',
    group,
    enabled: enabled && workspaceId !== '' && parentId !== '',
    handler: () => {
      if (busy.current) return;
      busy.current = true;
      const body =
        defaultDocument === null
          ? UNTITLED
          : { template_id: defaultDocument.id };
      void create(body).then((made) => {
        busy.current = false;
        if (made !== null) void navigate(documentPath(slug, made.document_id));
      });
    },
  });
};

export default useCreateDocumentCommand;
