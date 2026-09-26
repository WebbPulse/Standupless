/**
 * One embedded image or video, and one link to an attachment, as the static
 * renderer and the editor both show them. The stored target is resolved against
 * the page's media tokens at render time, so what reaches the browser is a
 * short lived signed URL and never the bare stored path. An image shows at its
 * natural size capped to the width of the text, and a video with the browser's
 * own controls.
 */

import React, { useState } from 'react';
import { LuFile, LuImageOff } from 'react-icons/lu';
import { cn } from '../../lib/cn';
import { useMediaUrl } from '../../lib/mediaContext';
import type { MediaKind } from '../../lib/media';

/** Props for MediaEmbed. */
export interface MediaEmbedProps {
  kind: MediaKind;
  src: string;
  alt: string;
  className?: string;
}

/** The box shown while an embed cannot load yet, or no longer can. */
const Placeholder: React.FC<{ label: string; failed: boolean }> = ({
  label,
  failed,
}) => (
  <span
    role="img"
    aria-label={label}
    className="inline-flex h-24 w-full max-w-sm items-center justify-center gap-2 rounded-md border border-line bg-raised align-middle text-xs text-text-faint"
  >
    {failed && <LuImageOff aria-hidden="true" className="h-4 w-4" />}
    {label}
  </span>
);

/** An embedded image or video. */
export const MediaEmbed: React.FC<MediaEmbedProps> = ({
  kind,
  src,
  alt,
  className,
}) => {
  const url = useMediaUrl(src);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const noun = kind === 'video' ? 'Video' : 'Image';
  const name = alt === '' ? noun : alt;

  if (url === null) {
    return <Placeholder label={`Loading ${name}`} failed={false} />;
  }
  if (failedUrl === url) {
    return <Placeholder label={`${noun} unavailable`} failed />;
  }
  const fail = (): void => {
    setFailedUrl(url);
  };
  if (kind === 'video') {
    return (
      <video
        src={url}
        controls
        preload="metadata"
        aria-label={name}
        className={cn(
          'inline-block max-h-[32rem] max-w-full rounded-md border border-line bg-black align-middle',
          className
        )}
        onError={fail}
      />
    );
  }
  return (
    <img
      src={url}
      alt={alt}
      loading="lazy"
      className={cn(
        'inline-block h-auto max-w-full rounded-md border border-line align-middle',
        className
      )}
      onError={fail}
    />
  );
};

/** Props for AttachmentLink. */
export interface AttachmentLinkProps {
  href: string;
  children: React.ReactNode;
}

/** A link to an attached file, opened through a signed URL. */
export const AttachmentLink: React.FC<AttachmentLinkProps> = ({
  href,
  children,
}) => {
  const url = useMediaUrl(href);
  const chip =
    'inline-flex max-w-full items-center gap-1 rounded-sm border border-line bg-raised px-1.5 align-middle text-xs leading-5 text-text';
  const icon = (
    <LuFile aria-hidden="true" className="h-3 w-3 shrink-0 text-text-faint" />
  );
  if (url === null) {
    return (
      <span className={cn(chip, 'text-text-muted')}>
        {icon}
        <span className="truncate">{children}</span>
      </span>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(chip, 'hover:border-line-strong')}
    >
      {icon}
      <span className="truncate">{children}</span>
    </a>
  );
};

export default MediaEmbed;
