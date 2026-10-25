/**
 * How a video or Figma embed looks in the editor: the provider's frame, a
 * menu with "Open link" and "Convert to link" over its corner, and a "Keep as
 * link" choice under it while it is selected. A link that no longer parses
 * shows as its text, so a frame is never built from anything but a checked id.
 */

import type { ReactNodeViewProps } from '@tiptap/react';
import { NodeViewWrapper } from '@tiptap/react';
import React from 'react';
import { LuEllipsis, LuExternalLink, LuLink } from 'react-icons/lu';
import { cn } from '../../lib/cn';
import { parseVideoEmbed } from '../../lib/videoEmbeds';
import { VideoEmbedFrame } from '../media/VideoEmbedFrame';
import { Button, IconButton } from '../ui/button';
import { Menu, MenuItem } from '../ui/menu';

/** A video embed node, with its menu and the keep as link choice. */
export const VideoEmbedView: React.FC<ReactNodeViewProps> = ({
  node,
  editor,
  getPos,
  selected,
}) => {
  const url = typeof node.attrs['url'] === 'string' ? node.attrs['url'] : '';
  const embed = parseVideoEmbed(url);
  const actionsLabel =
    embed?.provider === 'figma' ? 'Figma actions' : 'Video actions';
  const editable = editor.isEditable;

  const convert = (): void => {
    const pos = getPos();
    if (typeof pos !== 'number') return;
    editor.chain().focus().convertVideoEmbedToLink(pos).run();
  };
  const open = (): void => {
    if (embed === null) return;
    globalThis.open(embed.url, '_blank', 'noopener,noreferrer');
  };

  return (
    <NodeViewWrapper
      as="div"
      data-drag-handle=""
      contentEditable={false}
      className={cn(
        'rich-video-embed group/video relative my-1 w-full max-w-2xl rounded-md',
        selected && editable && 'outline-2 outline-offset-2 outline-accent'
      )}
    >
      {embed === null ? (
        <span className="text-text-muted">{url}</span>
      ) : (
        <VideoEmbedFrame embed={embed} />
      )}
      {editable && embed !== null && (
        <div
          data-video-embed-controls=""
          className={cn(
            'absolute top-1.5 right-1.5 rounded-sm bg-overlay shadow-overlay transition-opacity',
            selected
              ? 'opacity-100'
              : 'opacity-0 group-hover/video:opacity-100 focus-within:opacity-100'
          )}
        >
          <Menu
            label={actionsLabel}
            align="end"
            trigger={(props) => (
              <IconButton label={actionsLabel} size="sm" {...props}>
                <LuEllipsis aria-hidden="true" className="h-3.5 w-3.5" />
              </IconButton>
            )}
          >
            <MenuItem onSelect={open}>
              <LuExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
              Open link
            </MenuItem>
            <MenuItem onSelect={convert}>
              <LuLink aria-hidden="true" className="h-3.5 w-3.5" />
              Convert to link
            </MenuItem>
          </Menu>
        </div>
      )}
      {editable && selected && embed !== null && (
        <div data-video-embed-controls="" className="mt-1.5 flex">
          <Button size="sm" variant="ghost" onClick={convert}>
            <LuLink aria-hidden="true" className="h-3.5 w-3.5" />
            Keep as link
          </Button>
        </div>
      )}
    </NodeViewWrapper>
  );
};

export default VideoEmbedView;
