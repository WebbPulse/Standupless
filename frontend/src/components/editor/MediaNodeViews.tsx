/**
 * How the editor's media nodes look: an image node as the embed it stands for,
 * so a stored content path never reaches an `<img>` without its token, and an
 * upload placeholder as the file's name over a progress bar.
 */

import type { ReactNodeViewProps } from '@tiptap/react';
import { NodeViewWrapper } from '@tiptap/react';
import React from 'react';
import { LuFile, LuFilm, LuImage } from 'react-icons/lu';
import { cn } from '../../lib/cn';
import { isEmbeddableSrc, isVideoSrc, type MediaKind } from '../../lib/media';
import { useUploadProgress } from '../../lib/uploadProgress';
import { MediaEmbed } from '../media/MediaEmbed';

/** The embed an image node shows, so a stored path never reaches an `<img>`. */
export const EmbedView: React.FC<ReactNodeViewProps> = ({ node, selected }) => {
  const src = typeof node.attrs['src'] === 'string' ? node.attrs['src'] : '';
  const alt = typeof node.attrs['alt'] === 'string' ? node.attrs['alt'] : '';
  return (
    <NodeViewWrapper
      as="div"
      data-drag-handle=""
      className={cn(
        'rich-embed my-1 w-fit max-w-full rounded-md',
        selected && 'outline-2 outline-offset-2 outline-accent'
      )}
    >
      {isEmbeddableSrc(src) ? (
        <MediaEmbed
          kind={isVideoSrc(src) ? 'video' : 'image'}
          src={src}
          alt={alt}
        />
      ) : (
        <span className="text-text-muted">{`![${alt}](${src})`}</span>
      )}
    </NodeViewWrapper>
  );
};

/** A file in flight: its name, what it will become, and a progress bar. */
export const UploadView: React.FC<ReactNodeViewProps> = ({ node }) => {
  const uploadId = String(node.attrs['uploadId'] ?? '');
  const name = String(node.attrs['name'] ?? '');
  const kind = node.attrs['kind'] as MediaKind | null;
  const fraction = useUploadProgress(uploadId);
  const Icon = kind === 'video' ? LuFilm : kind === 'image' ? LuImage : LuFile;
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <NodeViewWrapper
      as="div"
      contentEditable={false}
      className="my-1 w-full max-w-sm rounded-md border border-line bg-raised px-3 py-2"
    >
      <div className="flex items-center gap-2 text-xs text-text-muted">
        <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <span className="shrink-0 tabular-nums">{percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={`Uploading ${name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="mt-1.5 h-1 overflow-hidden rounded-full bg-line"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-150"
          style={{ width: `${String(percent)}%` }}
        />
      </div>
    </NodeViewWrapper>
  );
};
