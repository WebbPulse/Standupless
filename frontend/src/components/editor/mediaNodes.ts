/**
 * The editor's side of inline media: the image node shown as the embed it
 * stands for, the placeholder a file sits in while it uploads, and the routine
 * that turns pasted, dropped or picked files into one or the other.
 *
 * An image and a video are the same node, because both are written as the
 * Markdown image `![name](path)` and only the `media=video` marker on the
 * stored path tells them apart. Keeping one node means the round trip needs
 * nothing new, and GitHub and email still read a video as a named embed.
 *
 * The upload placeholder writes no Markdown at all, so a document committed
 * while a file is still in flight saves without it rather than with a broken
 * reference, and the finished embed commits in its place once it lands.
 */

import type { Editor } from '@tiptap/core';
import { Node } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { ReactNodeViewRenderer } from '@tiptap/react';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { errorMessage } from '../../lib/errors';
import { mediaKindOf, type MediaKind } from '../../lib/media';
import { showErrorToast } from '../../lib/toast';
import {
  clearUploadProgress,
  setUploadProgress,
} from '../../lib/uploadProgress';
import { describeUploadRefusal } from '../../lib/uploads';
import { EmbedView, UploadView } from './MediaNodeViews';

/** What an upload hands back to be written into the document. */
export interface UploadedFile {
  /** The stored content path of the new attachment. */
  src: string;
  /** How it shows: an embed, or a link to the file when null. */
  kind: MediaKind | null;
}

/** Uploads one file, reporting the fraction sent as it goes. */
export type UploadFile = (
  file: File,
  onProgress: (fraction: number) => void
) => Promise<UploadedFile>;

/** The image node, shown through the page's media tokens. */
export const MediaImage = Image.extend({
  addNodeView() {
    return ReactNodeViewRenderer(EmbedView);
  },
});

/** The placeholder a file sits in while it uploads. Never written to Markdown. */
export const MediaUpload = Node.create({
  name: 'mediaUpload',
  group: 'block',
  atom: true,
  selectable: false,
  draggable: false,

  addAttributes() {
    return {
      uploadId: { default: '' },
      name: { default: '' },
      kind: { default: null },
    };
  },

  parseHTML() {
    return [];
  },

  renderHTML() {
    return ['div', { 'data-media-upload': '' }];
  },

  renderMarkdown: () => '',

  addNodeView() {
    return ReactNodeViewRenderer(UploadView);
  },
});

/** Where one placeholder sits in the document now, or null once it is gone. */
const findUpload = (
  editor: Editor,
  uploadId: string
): { node: ProseMirrorNode; pos: number } | null => {
  let found: { node: ProseMirrorNode; pos: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (
      node.type.name === 'mediaUpload' &&
      node.attrs['uploadId'] === uploadId
    ) {
      found = { node, pos };
      return false;
    }
    return true;
  });
  return found;
};

/** Swaps a placeholder for what its upload became, or removes it. */
const settle = (
  editor: Editor,
  uploadId: string,
  replacement: ProseMirrorNode | null
): void => {
  if (editor.isDestroyed) return;
  const at = findUpload(editor, uploadId);
  if (at === null) return;
  const { tr } = editor.state;
  const end = at.pos + at.node.nodeSize;
  if (replacement === null) tr.delete(at.pos, end);
  else tr.replaceWith(at.pos, end, replacement);
  editor.view.dispatch(tr);
};

/** The node a finished upload becomes: an embed, or a paragraph linking the file. */
const finishedNode = (
  editor: Editor,
  file: File,
  uploaded: UploadedFile
): ProseMirrorNode | null => {
  const { schema } = editor.state;
  if (uploaded.kind !== null) {
    return (
      schema.nodes['image']?.create({ src: uploaded.src, alt: file.name }) ??
      null
    );
  }
  const link = schema.marks['link']?.create({ href: uploaded.src });
  const paragraph = schema.nodes['paragraph'];
  if (link === undefined || paragraph === undefined) return null;
  return paragraph.create(null, schema.text(file.name, [link]));
};

/** A counter for placeholder ids, unique within the tab. */
let nextUpload = 0;

/**
 * Uploads each file into the document at a position, or at the caret when no
 * position is given: a placeholder with a progress bar first, then the embed or
 * file link once the bytes land. A file the server would refuse is named in a
 * toast and never uploaded.
 */
export const insertUploads = (
  editor: Editor,
  files: File[],
  upload: UploadFile,
  position?: number
): void => {
  let at = position ?? editor.state.selection.to;
  for (const file of files) {
    const refusal = describeUploadRefusal(file);
    if (refusal !== null) {
      showErrorToast(`${file.name}: ${refusal}`);
      continue;
    }
    nextUpload += 1;
    const uploadId = `media-upload-${String(nextUpload)}`;
    setUploadProgress(uploadId, 0);
    const before = editor.state.doc.content.size;
    editor
      .chain()
      .insertContentAt(at, {
        type: 'mediaUpload',
        attrs: { uploadId, name: file.name, kind: mediaKindOf(file.type) },
      })
      .run();
    at = Math.min(
      editor.state.doc.content.size,
      at + editor.state.doc.content.size - before
    );
    upload(file, (fraction) => {
      setUploadProgress(uploadId, fraction);
    })
      .then((uploaded) => {
        settle(editor, uploadId, finishedNode(editor, file, uploaded));
      })
      .catch((failure: unknown) => {
        settle(editor, uploadId, null);
        showErrorToast(errorMessage(failure, `Could not upload ${file.name}.`));
      })
      .finally(() => {
        clearUploadProgress(uploadId);
      });
  }
};

/** Whether any placeholder is still in the document. */
export const hasUploadsInFlight = (editor: Editor): boolean => {
  let found = false;
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'mediaUpload') found = true;
    return !found;
  });
  return found;
};
