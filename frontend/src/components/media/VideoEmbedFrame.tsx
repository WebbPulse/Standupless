/**
 * An embedded video player from one of the allowlisted providers, as the
 * static renderer and the editor both show it. The iframe loads only the
 * player address rebuilt from the parsed video id, lazily, sandboxed, and in a
 * fixed 16:9 box so the text around it never jumps as it loads.
 */

import React from 'react';
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

/** A provider's player in a sandboxed, lazily loaded 16:9 frame. */
export const VideoEmbedFrame: React.FC<VideoEmbedFrameProps> = ({
  embed,
  className,
}) => (
  <div
    className={cn(
      'relative aspect-video w-full max-w-2xl overflow-hidden rounded-md border border-line bg-raised',
      className
    )}
  >
    <iframe
      src={embed.embedUrl}
      title={`${VIDEO_PROVIDER_LABELS[embed.provider]} video`}
      loading="lazy"
      sandbox={SANDBOX}
      allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
      allowFullScreen
      referrerPolicy="strict-origin-when-cross-origin"
      className="absolute inset-0 h-full w-full border-0"
    />
  </div>
);

export default VideoEmbedFrame;
