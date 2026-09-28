/**
 * The upload, preview, replace and remove control for an icon: a workspace
 * logo, a team icon or a person's avatar. The chosen file is checked against
 * the server's rules before any bytes move, previewed from the local file
 * while it uploads, and replaced by the committed image once the save lands.
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import { describeIconRefusal, ICON_CONTENT_TYPES } from '../../api/icons';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { ErrorAlert } from './alert';
import Avatar from './avatar';
import Button from './button';

/** Props for IconUploader. */
export interface IconUploaderProps {
  /** What the icon is for, read as the control's heading. */
  label: string;
  /** One line under the heading saying where the icon shows. */
  description: string;
  /** The name the initials fallback is drawn from. */
  name: string;
  /** The current icon, or null when the initials show. */
  src: string | null | undefined;
  /** A circle for a person, a rounded square for a workspace or a team. */
  shape?: 'circle' | 'square';
  /** Whether the caller may change the icon. */
  canEdit: boolean;
  /** Uploads and commits one image as the icon. */
  onUpload: (file: File) => Promise<void>;
  /** Removes the icon, bringing the initials back. */
  onRemove: () => Promise<void>;
}

/** An icon preview with the controls that change it. */
export const IconUploader: React.FC<IconUploaderProps> = ({
  label,
  description,
  name,
  src,
  shape = 'square',
  canEdit,
  onUpload,
  onRemove,
}) => {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => () => {
      if (preview !== null) URL.revokeObjectURL(preview);
    },
    [preview]
  );

  const choose = async (file: File): Promise<void> => {
    const refusal = describeIconRefusal(file);
    if (refusal !== null) {
      setError(refusal);
      return;
    }
    setError(null);
    setPreview(URL.createObjectURL(file));
    setBusy('upload');
    try {
      await onUpload(file);
    } catch (caught) {
      setError(errorMessage(caught, 'Could not upload the image.'));
    } finally {
      setPreview(null);
      setBusy(null);
    }
  };

  const remove = async (): Promise<void> => {
    setError(null);
    setBusy('remove');
    try {
      await onRemove();
    } catch (caught) {
      setError(errorMessage(caught, 'Could not remove the image.'));
    } finally {
      setBusy(null);
    }
  };

  const shown = preview ?? src ?? null;
  const hasIcon = src !== null && src !== undefined && src !== '';

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4">
        <Avatar
          name={name}
          src={shown}
          size="lg"
          shape={shape}
          className={cn(busy === 'upload' && 'opacity-60')}
        />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-medium text-text">{label}</p>
          <p className="text-xs text-text-muted">{description}</p>
        </div>
        {canEdit && (
          <div className="flex shrink-0 items-center gap-2">
            <input
              ref={input}
              id={inputId}
              type="file"
              accept={ICON_CONTENT_TYPES.join(',')}
              className="sr-only"
              tabIndex={-1}
              aria-label={`Choose ${label.toLowerCase()} image`}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file !== undefined) void choose(file);
              }}
            />
            <Button
              type="button"
              size="sm"
              disabled={busy !== null}
              onClick={() => input.current?.click()}
            >
              {busy === 'upload'
                ? 'Uploading'
                : hasIcon
                  ? 'Replace'
                  : 'Upload image'}
            </Button>
            {hasIcon && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => void remove()}
              >
                {busy === 'remove' ? 'Removing' : 'Remove'}
              </Button>
            )}
          </div>
        )}
      </div>
      {error !== null && <ErrorAlert message={error} />}
    </div>
  );
};

export default IconUploader;
