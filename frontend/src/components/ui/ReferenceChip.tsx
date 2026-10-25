/**
 * A link to a project or a document of this workspace, drawn as a chip with
 * the project's mark or a page glyph and the name it carries today, the way
 * issue keys already render. The name is read live, so a rename shows
 * everywhere it was linked, and until the read lands, or when the reader
 * cannot see the target, the chip shows the link's own text.
 */

import React, { useContext } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { LuFileText } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import { getDocument } from '../../api/documents';
import { getProject } from '../../api/planning';
import { WorkspaceContext } from '../../contexts/WorkspaceContextDefinition';
import { documentPath, projectPath } from '../../lib/paths';
import { projectGlyph } from '../../lib/projectLook';
import { LOOKUP_POLL_MS } from '../../lib/polling';
import { documentKey, projectDetailKey } from '../../lib/queryKeys';
import { useLinkedReference } from '../../hooks/useLinkedReference';
import { currentOrigin, type LinkedReference } from '../../lib/references';
import type { ProjectIconName } from '../../types/Api';

/** The classes every reference chip shares with the issue chip. */
const REFERENCE_CHIP_CLASS =
  'inline-flex max-w-full items-baseline gap-1 rounded-xs bg-raised px-1 align-baseline text-[0.95em] text-text no-underline transition-colors duration-100 hover:bg-line';

/** A project's glyph at chip size, in the project's own colour when it has one. */
export const ProjectMark: React.FC<{
  icon: ProjectIconName | null;
  color: string | null;
}> = ({ icon, color }) =>
  React.createElement(projectGlyph(icon), {
    'aria-hidden': true,
    className: 'h-3 w-3 shrink-0 self-center text-text-muted',
    ...(color === null ? {} : { style: { color } }),
  });

/** Props for a chip whose target is known to be in this workspace. */
interface ResolvedChipProps {
  workspaceId: string;
  slug: string;
  target: LinkedReference;
  fallback: React.ReactNode;
  /** The link as written, which a quoted passage keeps. */
  href: string;
}

/** A linked project, with its own mark and current name. */
const ProjectChip: React.FC<ResolvedChipProps> = ({
  workspaceId,
  slug,
  target,
  fallback,
  href,
}) => {
  const auth = useQueryAuth();
  const { data: project } = usePolledQuery(
    ({ signal }) => getProject(workspaceId, target.id, undefined, signal),
    {
      intervalMs: LOOKUP_POLL_MS,
      queryKey: projectDetailKey(workspaceId, target.id),
      auth,
    }
  );
  return (
    <Link
      to={projectPath(slug, {
        project_id: target.id,
        name: project?.name,
      })}
      title={project?.name}
      data-reference="project"
      data-md-href={href}
      className={REFERENCE_CHIP_CLASS}
    >
      <ProjectMark
        icon={project?.icon ?? null}
        color={project?.color ?? null}
      />
      <span className="min-w-0 truncate">{project?.name ?? fallback}</span>
    </Link>
  );
};

/** A linked document, with a page glyph and its current title. */
const DocumentChip: React.FC<ResolvedChipProps> = ({
  workspaceId,
  slug,
  target,
  fallback,
  href,
}) => {
  const auth = useQueryAuth();
  const { data: document } = usePolledQuery(
    ({ signal }) => getDocument(workspaceId, target.id, signal),
    {
      intervalMs: LOOKUP_POLL_MS,
      queryKey: documentKey(workspaceId, target.id),
      auth,
    }
  );
  return (
    <Link
      to={documentPath(slug, target.id)}
      title={document?.title}
      data-reference="document"
      data-md-href={href}
      className={REFERENCE_CHIP_CLASS}
    >
      <LuFileText
        aria-hidden="true"
        className="h-3 w-3 shrink-0 self-center text-text-muted"
      />
      <span className="min-w-0 truncate">{document?.title ?? fallback}</span>
    </Link>
  );
};

/** Props for ReferenceChip: the link's address and its written text. */
export interface ReferenceChipProps {
  href: string;
  children: React.ReactNode;
  /** The origin a link must point at to be read as a reference. */
  origin?: string;
}

/** A project or document link in rendered Markdown, drawn as a chip. */
export const ReferenceChip: React.FC<ReferenceChipProps> = ({
  href,
  children,
  origin = currentOrigin(),
}) => {
  const workspace = useContext(WorkspaceContext)?.workspace ?? null;
  const target = useLinkedReference(href, origin);
  if (workspace === null || target === null) return <>{children}</>;
  const Chip = target.kind === 'project' ? ProjectChip : DocumentChip;
  return (
    <Chip
      workspaceId={workspace.id}
      slug={workspace.slug}
      target={target}
      fallback={children}
      href={href}
    />
  );
};

export default ReferenceChip;
