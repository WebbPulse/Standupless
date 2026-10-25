/**
 * The Emoji page of workspace settings: the workspace's own custom emoji,
 * each with its name, image and who uploaded it. Any member but a guest adds
 * one from a PNG, GIF or WebP image, which the server resizes; the uploader or
 * a workspace admin deletes one, and text that used it keeps its `:name:`.
 */

import React, { useRef, useState } from 'react';
import { LuTrash2 } from 'react-icons/lu';
import { useMutationWithRefetch } from '@webbpulse/api-client/react';
import {
  CUSTOM_EMOJI_CONTENT_TYPES,
  CUSTOM_EMOJI_NAME,
  deleteCustomEmoji,
  describeCustomEmojiRefusal,
  uploadCustomEmoji,
} from '../../api/customEmoji';
import { ErrorAlert } from '../../components/ui/alert';
import Button, { IconButton } from '../../components/ui/button';
import { CustomEmojiImage } from '../../components/ui/custom-emoji';
import Field from '../../components/ui/field';
import { SkeletonRows } from '../../components/ui/skeleton';
import { ConfirmDeleteDialog } from '../../components/workflow/InheritedControls';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useAuth } from '../../hooks/useAuth';
import { useCustomEmojiList } from '../../hooks/useCustomEmojiList';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canManageMembers } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import type { CustomEmojiRead } from '../../types/Api';

/** The name a file suggests: its base name in the shape a custom emoji takes. */
export const suggestedName = (fileName: string): string =>
  fileName
    .replace(/\.[^.]*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 32);

/** Why a typed name cannot be a custom emoji, or null when it has the right shape. */
export const nameProblem = (name: string): string | null =>
  CUSTOM_EMOJI_NAME.test(name)
    ? null
    : 'Use 2 to 32 lowercase letters, digits, dashes or underscores.';

/** Lists, adds and deletes the workspace's custom emoji. */
const CustomEmojiSettings: React.FC = () => {
  const { workspace } = useWorkspace();
  const { user } = useAuth();
  const workspaceId = workspace?.id ?? '';
  const isAdmin = canManageMembers(workspace?.role);
  const canAdd = workspace?.role !== undefined && workspace.role !== 'guest';
  const { emoji, error, isLoading, queryKey } = useCustomEmojiList(
    workspaceId,
    workspaceId !== ''
  );
  const [writeError, setWriteError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [deleting, setDeleting] = useState<CustomEmojiRead | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const { mutate: create } = useMutationWithRefetch(
    (body: { name: string; file: File }) =>
      uploadCustomEmoji(workspaceId, body.name, body.file),
    [queryKey]
  );
  const { mutate: remove } = useMutationWithRefetch(
    (row: CustomEmojiRead) => deleteCustomEmoji(workspaceId, row.name),
    [queryKey]
  );

  const typed = name.trim().replaceAll(':', '').toLowerCase();
  const problem = typed === '' ? null : nameProblem(typed);

  const choose = (chosen: File): void => {
    const refusal = describeCustomEmojiRefusal(chosen);
    if (refusal !== null) {
      setWriteError(refusal);
      return;
    }
    setWriteError(null);
    setFile(chosen);
    if (name.trim() === '') setName(suggestedName(chosen.name));
  };

  const onAdd = (event: React.FormEvent): void => {
    event.preventDefault();
    if (file === null || typed === '' || problem !== null || isAdding) return;
    setWriteError(null);
    setIsAdding(true);
    void create({ name: typed, file })
      .then(() => {
        setName('');
        setFile(null);
      })
      .catch((cause: unknown) => {
        setWriteError(errorMessage(cause, 'Could not add that emoji.'));
      })
      .finally(() => {
        setIsAdding(false);
      });
  };

  const canDelete = (row: CustomEmojiRead): boolean =>
    isAdmin ||
    (user !== null && user !== undefined && row.created_by === user.id);

  const renderRow = (row: CustomEmojiRead): React.ReactNode => (
    <li
      key={row.name}
      className="flex min-h-row items-center gap-3 border-b border-line py-1 pl-3 pr-3 transition-colors duration-100 last:border-b-0 hover:bg-surface"
    >
      <CustomEmojiImage emoji={row} className="h-6 w-6 align-middle" />
      <span className="min-w-0 flex-1 truncate font-mono text-sm text-text">
        {row.shortcode}
      </span>
      <span className="truncate text-xs text-text-muted">
        {row.created_by_name}
      </span>
      {canDelete(row) && (
        <IconButton
          label={`Delete ${row.shortcode}`}
          size="sm"
          onClick={() => {
            setDeleting(row);
          }}
        >
          <LuTrash2 className="h-3.5 w-3.5" />
        </IconButton>
      )}
    </li>
  );

  return (
    <WorkspaceShell title="Settings">
      <div className="max-w-2xl space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">Emoji</h2>
          <p className="text-sm text-text-muted">
            Custom emoji for this workspace. Use them as reactions or type their
            name between colons in descriptions and comments. Any member can add
            one; the uploader or an admin can delete it.
          </p>
        </div>

        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load the custom emoji.')}
          />
        )}
        {writeError !== null && <ErrorAlert message={writeError} />}

        {canAdd && (
          <form
            aria-label="Add a custom emoji"
            className="flex flex-wrap items-start gap-3 rounded-md border border-line px-3 py-2"
            onSubmit={onAdd}
          >
            <input
              ref={input}
              type="file"
              accept={CUSTOM_EMOJI_CONTENT_TYPES.join(',')}
              className="sr-only"
              tabIndex={-1}
              aria-label="Choose emoji image"
              onChange={(event) => {
                const chosen = event.target.files?.[0];
                event.target.value = '';
                if (chosen !== undefined) choose(chosen);
              }}
            />
            <Button
              type="button"
              size="sm"
              onClick={() => input.current?.click()}
            >
              {file === null ? 'Choose image' : file.name}
            </Button>
            <div className="w-56 space-y-1">
              <Field
                id="new-custom-emoji"
                label="Emoji name"
                hideLabel
                placeholder="emoji-name"
                value={name}
                autoComplete="off"
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
              {problem !== null && (
                <p className="text-xs text-danger">{problem}</p>
              )}
            </div>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              className="ml-auto"
              disabled={
                file === null || typed === '' || problem !== null || isAdding
              }
            >
              {isAdding ? 'Adding' : 'Add emoji'}
            </Button>
          </form>
        )}

        {isLoading && emoji.length === 0 ? (
          <SkeletonRows count={4} label="Loading custom emoji" />
        ) : emoji.length === 0 ? (
          <p className="text-sm text-text-muted">No custom emoji yet.</p>
        ) : (
          <ul
            aria-label="Custom emoji"
            className="rounded-md border border-line"
          >
            {emoji.map(renderRow)}
          </ul>
        )}

        <ConfirmDeleteDialog
          open={deleting !== null}
          title={`Delete ${deleting?.shortcode ?? 'emoji'}?`}
          description="Text and reactions that use it show its name instead."
          onCancel={() => {
            setDeleting(null);
          }}
          onConfirm={() => {
            const target = deleting;
            setDeleting(null);
            if (target !== null) {
              setWriteError(null);
              void remove(target).catch((cause: unknown) => {
                setWriteError(
                  errorMessage(cause, 'Could not delete that emoji.')
                );
              });
            }
          }}
        />
      </div>
    </WorkspaceShell>
  );
};

export default CustomEmojiSettings;
