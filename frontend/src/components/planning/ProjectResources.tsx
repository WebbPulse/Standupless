/**
 * A project's Resources on its overview: the external links that belong with
 * the plan, such as a spec, a design file or a dashboard, in their manual
 * order. Each row shows the site's favicon, or a link glyph when there is
 * none, and the title or, without one, the hostname, and opens in a new tab.
 * A small form adds or edits a link, and the row menu copies, moves or
 * removes it. The favicon loads in the reader's browser; the server never
 * fetches a link.
 */

import React, { useState } from 'react';
import {
  LuArrowDown,
  LuArrowUp,
  LuCopy,
  LuEllipsis,
  LuLink,
  LuPencil,
  LuPlus,
  LuTrash2,
} from 'react-icons/lu';
import { reorderKey } from '../../lib/milestones';
import { linkLabel, normalisedUrl, webUrl } from '../../lib/projectLinks';
import { showErrorToast, showToast } from '../../lib/toast';
import type {
  ProjectLinkCreate,
  ProjectLinkRead,
  ProjectLinkUpdate,
} from '../../types/Api';
import { Button, IconButton } from '../ui/button';
import { Input } from '../ui/input';
import Menu, { MenuItem, MenuSeparator } from '../ui/menu';

/** The longest URL a link may carry, as the server holds it. */
const URL_MAX = 2048;

/** The longest title a link may carry, as the server holds it. */
const TITLE_MAX = 200;

/** The site's icon beside a link, falling back to a link glyph. */
const LinkIcon: React.FC<{ url: string }> = ({ url }) => {
  const [failed, setFailed] = useState(false);
  const parsed = webUrl(url);
  if (parsed === null || failed) {
    return (
      <LuLink
        aria-hidden="true"
        data-testid="link-glyph"
        className="h-3.5 w-3.5 shrink-0 text-text-faint"
      />
    );
  }
  return (
    <img
      src={`${parsed.origin}/favicon.ico`}
      alt=""
      width={14}
      height={14}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="h-3.5 w-3.5 shrink-0 rounded-xs"
      onError={() => {
        setFailed(true);
      }}
    />
  );
};

/** Props for LinkForm. */
interface LinkFormProps {
  initial?: ProjectLinkRead;
  onSave: (body: { url: string; title: string | null }) => Promise<unknown>;
  onDone: () => void;
}

/** The URL and title fields a link is added or edited through. */
const LinkForm: React.FC<LinkFormProps> = ({ initial, onSave, onDone }) => {
  const [url, setUrl] = useState(initial?.url ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = (): void => {
    if (url.trim() === '') {
      setError('Enter a URL.');
      return;
    }
    const target = normalisedUrl(url);
    if (webUrl(target) === null || target.length > URL_MAX) {
      setError('Enter a web address starting with http or https.');
      return;
    }
    setError(null);
    setSaving(true);
    const trimmed = title.trim();
    void onSave({ url: target, title: trimmed === '' ? null : trimmed })
      .then(() => {
        onDone();
      })
      .catch(() => {
        setSaving(false);
      });
  };

  return (
    <form
      aria-label={initial === undefined ? 'Add link' : 'Edit link'}
      className="space-y-2 rounded-md border border-line bg-surface p-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onDone();
        }
      }}
    >
      <Input
        aria-label="URL"
        placeholder="https://"
        autoFocus
        type="text"
        inputMode="url"
        maxLength={URL_MAX}
        value={url}
        aria-invalid={error !== null}
        onChange={(event) => {
          setUrl(event.target.value);
          setError(null);
        }}
      />
      <Input
        aria-label="Title"
        placeholder="Title (optional)"
        maxLength={TITLE_MAX}
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
        }}
      />
      {error !== null && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={saving}>
          {initial === undefined ? 'Add link' : 'Save'}
        </Button>
      </div>
    </form>
  );
};

/** Props for ResourceRow. */
interface ResourceRowProps {
  link: ProjectLinkRead;
  index: number;
  count: number;
  canEdit: boolean;
  onEdit: () => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}

/** One link: its icon and label, opening in a new tab, and its actions. */
const ResourceRow: React.FC<ResourceRowProps> = ({
  link,
  index,
  count,
  canEdit,
  onEdit,
  onMove,
  onRemove,
}) => {
  const label = linkLabel(link);
  const copy = (): void => {
    void navigator.clipboard
      .writeText(link.url)
      .then(() => {
        showToast('Link copied');
      })
      .catch(() => {
        showErrorToast('Could not copy the link.');
      });
  };
  return (
    <li className="group/resource flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-surface">
      <a
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        title={link.url}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-sm text-text focus-visible:outline-2 focus-visible:outline-accent"
      >
        <LinkIcon url={link.url} />
        <span className="truncate">{label}</span>
      </a>
      <Menu
        label={`${label} actions`}
        align="end"
        trigger={(trigger) => (
          <IconButton
            label={`${label} actions`}
            size="sm"
            className="opacity-0 group-hover/resource:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100"
            {...trigger}
          >
            <LuEllipsis className="h-3.5 w-3.5" />
          </IconButton>
        )}
      >
        <MenuItem onSelect={copy}>
          <LuCopy aria-hidden="true" className="h-3.5 w-3.5" />
          Copy link
        </MenuItem>
        {canEdit && (
          <>
            <MenuItem onSelect={onEdit}>
              <LuPencil aria-hidden="true" className="h-3.5 w-3.5" />
              Edit
            </MenuItem>
            <MenuItem
              disabled={index === 0}
              onSelect={() => {
                onMove(index - 1);
              }}
            >
              <LuArrowUp aria-hidden="true" className="h-3.5 w-3.5" />
              Move up
            </MenuItem>
            <MenuItem
              disabled={index === count - 1}
              onSelect={() => {
                onMove(index + 1);
              }}
            >
              <LuArrowDown aria-hidden="true" className="h-3.5 w-3.5" />
              Move down
            </MenuItem>
            <MenuSeparator />
            <MenuItem danger onSelect={onRemove}>
              <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
              Remove
            </MenuItem>
          </>
        )}
      </Menu>
    </li>
  );
};

/** Props for ProjectResources. */
export interface ProjectResourcesProps {
  links: ProjectLinkRead[];
  canEdit: boolean;
  onCreate: (body: ProjectLinkCreate) => Promise<unknown>;
  onUpdate: (linkId: string, patch: ProjectLinkUpdate) => Promise<unknown>;
  onRemove: (link: ProjectLinkRead) => Promise<unknown>;
}

/** The section. */
export const ProjectResources: React.FC<ProjectResourcesProps> = ({
  links,
  canEdit,
  onCreate,
  onUpdate,
  onRemove,
}) => {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const move = (from: number, to: number): void => {
    const moving = links[from];
    const key = reorderKey(links, from, to);
    if (moving === undefined || key === null) return;
    void onUpdate(moving.link_id, { sort_order: key }).catch(() => undefined);
  };

  if (links.length === 0 && !adding && !canEdit) return null;

  return (
    <section aria-labelledby="project-resources" className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 id="project-resources" className="text-sm font-medium text-text">
          Resources
        </h2>
        {canEdit && (
          <IconButton
            label="Add link"
            size="sm"
            onClick={() => {
              setEditing(null);
              setAdding(true);
            }}
          >
            <LuPlus className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
      {links.length === 0 && !adding && (
        <p className="text-xs text-text-muted">
          Keep the spec, designs and dashboards the project needs one click
          away.
        </p>
      )}
      {links.length > 0 && (
        <ul aria-label="Resources" className="-mx-1.5">
          {links.map((link, index) =>
            editing === link.link_id ? (
              <li key={link.link_id} className="px-1.5 py-1">
                <LinkForm
                  initial={link}
                  onSave={(body) => onUpdate(link.link_id, body)}
                  onDone={() => {
                    setEditing(null);
                  }}
                />
              </li>
            ) : (
              <ResourceRow
                key={link.link_id}
                link={link}
                index={index}
                count={links.length}
                canEdit={canEdit}
                onEdit={() => {
                  setAdding(false);
                  setEditing(link.link_id);
                }}
                onMove={(to) => {
                  move(index, to);
                }}
                onRemove={() => {
                  void onRemove(link);
                }}
              />
            )
          )}
        </ul>
      )}
      {adding && (
        <LinkForm
          onSave={onCreate}
          onDone={() => {
            setAdding(false);
          }}
        />
      )}
    </section>
  );
};

export default ProjectResources;
