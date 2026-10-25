/**
 * An embedded player or preview from one of the allowlisted providers, as the
 * static renderer and the editor both show it. The iframe loads only the
 * address rebuilt from the parsed ids, lazily, sandboxed, and in a fixed 16:9
 * box so the text around it never jumps as it loads. A Figma preview carries
 * an "Open in Figma" link under it, as Linear's does.
 */

import React from 'react';
import { LuExternalLink } from 'react-icons/lu';
import { cn } from '../../lib/cn';
import { VIDEO_PROVIDER_LABELS, type VideoEmbed } from '../../lib/videoEmbeds';

/** Props for VideoEmbedFrame. */
export interface VideoEmbedFrameProps {
  embed: VideoEmbed;
  className?: string;
}

/** The sandbox a player runs in: its own scripts, fullscreen and popouts. */
const SANDBOX =
  'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation';

/** The accessible name of an embed's frame. */
const frameTitle = (embed: VideoEmbed): string =>
  embed.provider === 'figma'
    ? 'Figma preview'
    : `${VIDEO_PROVIDER_LABELS[embed.provider]} video`;

/** A provider's player in a sandboxed, lazily loaded 16:9 frame. */
export const VideoEmbedFrame: React.FC<VideoEmbedFrameProps> = ({
  embed,
  className,
}) => {
  const frame = (
    <div
      className={cn(
        'relative aspect-video w-full max-w-2xl overflow-hidden rounded-md border border-line bg-raised',
        embed.provider !== 'figma' && className
      )}
    >
      <iframe
        src={embed.embedUrl}
        title={frameTitle(embed)}
        loading="lazy"
        sandbox={SANDBOX}
        allow={
          embed.provider === 'figma'
            ? 'fullscreen; clipboard-write'
            : 'autoplay; encrypted-media; fullscreen; picture-in-picture'
        }
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        className="absolute inset-0 h-full w-full border-0"
      />
    </div>
  );
  if (embed.provider !== 'figma') return frame;
  return (
    <div className={cn('w-full max-w-2xl', className)}>
      {frame}
      <a
        href={embed.url}
        target="_blank"
        rel="noopener noreferrer"
        data-video-embed-controls=""
        className="mt-1 inline-flex items-center gap-1 text-xs text-text-muted hover:text-text"
      >
        <LuExternalLink aria-hidden="true" className="h-3 w-3" />
        Open in Figma
      </a>
    </div>
  );
};

export default VideoEmbedFrame;
