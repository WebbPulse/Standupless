/**
 * The issue mention chips the rich editor draws while editing, as the
 * rendered body draws them: the status glyph, the key in muted text and the
 * truncated title. The chips are decorations, so the stored Markdown keeps
 * the key exactly as written. Each key in the document is read through the
 * same batch lookup and shared cache the rendered chips use, by an invisible
 * probe that also draws the glyph the decorations clone, so a body costs one
 * request however many issues it mentions. A key that does not resolve stays
 * plain text. Clicking the glyph or title opens the issue, as does clicking
 * the key with Cmd or Ctrl held, or anywhere on the chip when the surface is
 * read-only.
 */

import type { Editor } from '@tiptap/core';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import { isTeamKey } from '../../lib/issueDisplay';
import { issuePath } from '../../lib/paths';
import { useIssueMention } from '../ui/IssueChip';
import { StatusIcon } from '../ui/StatusIcon';
import {
  issueKeysIn,
  referenceChipsKey,
  type IssueLook,
} from './markdownExtensions';

/**
 * How each mentioned issue in one editor looks, read by the decorations and
 * written by the probes.
 */
export class IssueLooks {
  private readonly looks = new Map<string, IssueLook>();

  /** The look of the issue `key` names, or undefined while unresolved. */
  get = (key: string): IssueLook | undefined =>
    this.looks.get(key.toUpperCase());

  /** Records or clears a look, returning whether the chips need redrawing. */
  set(key: string, look: IssueLook | undefined): boolean {
    const normalized = key.toUpperCase();
    const held = this.looks.get(normalized);
    if (look === undefined) return this.looks.delete(normalized);
    if (held?.signature === look.signature && held.icon === look.icon) {
      return false;
    }
    this.looks.set(normalized, look);
    return true;
  }
}

/** Props for one probe. */
interface IssueProbeProps {
  workspaceId: string;
  issueKey: string;
  looks: IssueLooks;
  onChange: () => void;
}

/** Reads one mentioned issue and keeps its look current for the decorations. */
const IssueProbe: React.FC<IssueProbeProps> = ({
  workspaceId,
  issueKey,
  looks,
  onChange,
}) => {
  const { issue, status, statuses } = useIssueMention(workspaceId, issueKey);
  const glyph = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const holder = glyph.current;
    const look =
      issue === null
        ? undefined
        : {
            title: issue.title,
            icon: holder?.firstElementChild ?? null,
            signature: `${issue.title}\u0000${holder?.innerHTML ?? ''}`,
          };
    if (looks.set(issueKey, look)) onChange();
  });

  useEffect(
    () => () => {
      if (looks.set(issueKey, undefined)) onChange();
    },
    [looks, issueKey, onChange]
  );

  return (
    <span ref={glyph}>
      {issue !== null && (
        <StatusIcon
          status={status}
          statuses={statuses}
          className="h-3 w-3"
          {...(status === undefined ? {} : { name: status.name })}
        />
      )}
    </span>
  );
};

/** Opens the issue a chip names when it is clicked, inside the app's router. */
const ChipNavigation: React.FC<{
  surface: React.RefObject<HTMLElement | null>;
  slug: string;
}> = ({ surface, slug }) => {
  const navigate = useNavigate();

  useEffect(() => {
    const root = surface.current;
    if (root === null) return;
    const onClick = (event: MouseEvent): void => {
      if (!(event.target instanceof Element)) return;
      const part = event.target.closest<HTMLElement>(
        '.rich-issue-ref[data-issue-key]'
      );
      if (part === null || !root.contains(part)) return;
      const modified = event.metaKey || event.ctrlKey;
      const readOnly =
        part.closest('.ProseMirror[contenteditable="true"]') === null;
      if (!part.hasAttribute('data-issue-open') && !modified && !readOnly) {
        return;
      }
      event.preventDefault();
      const path = issuePath(slug, part.getAttribute('data-issue-key') ?? '');
      if (modified) globalThis.open(path, '_blank', 'noopener,noreferrer');
      else void navigate(path);
    };
    root.addEventListener('click', onClick);
    return () => {
      root.removeEventListener('click', onClick);
    };
  }, [surface, slug, navigate]);

  return null;
};

/** Props for IssueMentionChips. */
export interface IssueMentionChipsProps {
  editor: Editor;
  looks: IssueLooks;
  surface: React.RefObject<HTMLElement | null>;
  workspace: { id: string; slug: string } | null;
  teams:
    readonly { key_prefix: string; retired_key_prefixes?: string[] }[] | null;
}

/**
 * Reads every issue the editor's document mentions and redraws the chips as
 * they resolve. Renders nothing visible.
 */
export const IssueMentionChips: React.FC<IssueMentionChipsProps> = ({
  editor,
  looks,
  surface,
  workspace,
  teams,
}) => {
  const [keys, setKeys] = useState<string[]>([]);
  const inRouter = useInRouterContext();
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  const redraw = useCallback(() => {
    if (pending.current !== null) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      if (editor.isDestroyed) return;
      editor.view.dispatch(editor.state.tr.setMeta(referenceChipsKey, true));
    }, 0);
  }, [editor]);

  useEffect(
    () => () => {
      if (pending.current !== null) clearTimeout(pending.current);
    },
    []
  );

  useEffect(() => {
    if (teams === null) {
      setKeys([]);
      return;
    }
    const collect = (): void => {
      if (editor.isDestroyed) return;
      const found = issueKeysIn(editor.state.doc, (key) =>
        isTeamKey(key, teams)
      );
      setKeys((held) =>
        held.length === found.length &&
        held.every((key, index) => key === found[index])
          ? held
          : found
      );
    };
    const onTransaction = ({
      transaction,
    }: {
      transaction: { docChanged: boolean };
    }): void => {
      if (transaction.docChanged) collect();
    };
    collect();
    editor.on('transaction', onTransaction);
    return () => {
      editor.off('transaction', onTransaction);
    };
  }, [editor, teams]);

  if (workspace === null || teams === null) return null;
  return (
    <>
      <span hidden aria-hidden="true">
        {keys.map((key) => (
          <IssueProbe
            key={key}
            workspaceId={workspace.id}
            issueKey={key}
            looks={looks}
            onChange={redraw}
          />
        ))}
      </span>
      {inRouter && <ChipNavigation surface={surface} slug={workspace.slug} />}
    </>
  );
};

export default IssueMentionChips;
