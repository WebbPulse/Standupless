/**
 * The preview card an issue reference opens on hover: its key, title, status,
 * priority, assignee, labels, project and cycle, read from the same query keys
 * the issue page and the prefetch use, so a warm cache paints it at once.
 * Clicking anywhere on the card opens the issue. Triggers either spread the
 * props {@link useIssueHoverCard} returns, or, inside a surface that draws its
 * references itself such as the editor, hand the container to
 * {@link useDelegatedIssueHoverCard}.
 */

import React, { useContext, useEffect } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { LuRefreshCcw } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import { getIssueByKey } from '../../api/issues';
import { WorkspaceContext } from '../../contexts/WorkspaceContextDefinition';
import { useIssuePrefetch } from '../../hooks/useIssuePrefetch';
import { useTeamOptions } from '../../hooks/useTeamOptions';
import { PRIORITY_LABELS } from '../../lib/issueDisplay';
import { personLabel } from '../../lib/issuePeople';
import { issuePath } from '../../lib/paths';
import { issueKey } from '../../lib/queryKeys';
import { TRIAGE_STATUS } from '../../lib/triageStatus';
import type { IssueRead } from '../../types/Api';
import Avatar from './avatar';
import { PriorityGlyph } from './glyphs';
import {
  HoverCardPanel,
  canHover,
  hoverCardTriggerProps,
  useHoverCard,
  type HoverCardController,
  type HoverCardTriggerProps,
} from './hover-card';
import { ProjectMark } from './ReferenceChip';
import { Skeleton } from './skeleton';
import { StatusIcon } from './StatusIcon';

/** How often an open card re-reads its issue. */
const POLL_MS = 60000;

/** How many labels the card names before it counts the rest. */
const LABEL_LIMIT = 3;

/** The attribute a delegated reference carries its issue key in. */
export const ISSUE_KEY_ATTRIBUTE = 'data-issue-key';

/** One property on the card, drawn as a small outlined pill. */
const Pill: React.FC<{ children: React.ReactNode; label?: string }> = ({
  children,
  label,
}) => (
  <span
    {...(label === undefined ? {} : { title: label })}
    className="inline-flex h-5 max-w-full min-w-0 items-center gap-1 rounded-sm border border-line px-1.5 text-2xs text-text-muted"
  >
    {children}
  </span>
);

/** The card body while the issue's first read is in flight. */
const PreviewSkeleton: React.FC = () => (
  <div className="flex flex-col gap-2 p-3" aria-busy="true">
    <Skeleton className="h-3 w-20" />
    <Skeleton className="h-4 w-full" />
    <div className="flex gap-1">
      <Skeleton className="h-5 w-16" />
      <Skeleton className="h-5 w-14" />
      <Skeleton className="h-5 w-20" />
    </div>
  </div>
);

/** The properties of an issue whose read has landed. */
const PreviewBody: React.FC<{ workspaceId: string; issue: IssueRead }> = ({
  workspaceId,
  issue,
}) => {
  const { statuses, labels, people, projects, cycles } = useTeamOptions(
    workspaceId,
    issue.team_id,
    { planning: true }
  );
  const status =
    issue.in_triage === true
      ? TRIAGE_STATUS
      : statuses.find((item) => item.id === issue.status_id);
  const assignee =
    issue.assignee_id === null
      ? undefined
      : people.find((person) => person.user_id === issue.assignee_id);
  const issueLabels = issue.label_ids
    .map((id) => labels.find((label) => label.id === id))
    .filter((label) => label !== undefined);
  const project =
    issue.project_id === null
      ? undefined
      : projects.find((item) => item.project_id === issue.project_id);
  const cycle =
    issue.cycle_id === null
      ? undefined
      : cycles.find((item) => item.cycle_id === issue.cycle_id);
  const assigneeName =
    issue.assignee_id === null ? null : personLabel(assignee);

  return (
    <div className="flex flex-col gap-1.5 p-3">
      <div className="flex items-center gap-1.5 text-xs text-text-muted">
        <StatusIcon
          status={status}
          statuses={statuses}
          className="h-3.5 w-3.5 shrink-0"
        />
        <span className="font-mono">{issue.key}</span>
        {assigneeName !== null && (
          <Avatar
            name={assigneeName}
            src={assignee?.avatar_url ?? null}
            size="sm"
            className="ml-auto"
          />
        )}
      </div>
      <p className="line-clamp-2 text-sm leading-snug font-medium break-words text-text">
        {issue.title}
      </p>
      <div className="mt-0.5 flex flex-wrap items-center gap-1">
        {status !== undefined && (
          <Pill>
            <StatusIcon
              status={status}
              statuses={statuses}
              className="h-3 w-3 shrink-0"
            />
            <span className="truncate">{status.name}</span>
          </Pill>
        )}
        {issue.priority !== 'none' && (
          <Pill>
            <PriorityGlyph priority={issue.priority} className="h-3 w-3" />
            <span className="truncate">{PRIORITY_LABELS[issue.priority]}</span>
          </Pill>
        )}
        <Pill>
          {assigneeName === null ? (
            <span className="truncate">Unassigned</span>
          ) : (
            <>
              <Avatar
                name={assigneeName}
                src={assignee?.avatar_url ?? null}
                size="xs"
              />
              <span className="truncate">{assigneeName}</span>
            </>
          )}
        </Pill>
        {issueLabels.slice(0, LABEL_LIMIT).map((label) => (
          <Pill key={label.id}>
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: label.color }}
            />
            <span className="truncate">{label.name}</span>
          </Pill>
        ))}
        {issueLabels.length > LABEL_LIMIT && (
          <Pill
            label={issueLabels
              .slice(LABEL_LIMIT)
              .map((label) => label.name)
              .join(', ')}
          >
            +{issueLabels.length - LABEL_LIMIT}
          </Pill>
        )}
        {project !== undefined && (
          <Pill>
            <ProjectMark icon={project.icon} color={project.color} />
            <span className="truncate">{project.name}</span>
          </Pill>
        )}
        {cycle !== undefined && (
          <Pill>
            <LuRefreshCcw aria-hidden="true" className="h-3 w-3 shrink-0" />
            <span className="truncate">
              {cycle.name !== ''
                ? cycle.name
                : `Cycle ${String(cycle.number ?? '')}`}
            </span>
          </Pill>
        )}
      </div>
    </div>
  );
};

/** The card's content for one issue key: a skeleton, the issue, or not found. */
export const IssuePreview: React.FC<{
  issueKeyText: string;
  onOpen: () => void;
}> = ({ issueKeyText, onOpen }) => {
  const workspace = useContext(WorkspaceContext)?.workspace ?? null;
  const workspaceId = workspace?.id ?? '';
  const auth = useQueryAuth();
  const { data: issue, isLoading } = usePolledQuery(
    (context) => getIssueByKey(workspaceId, issueKeyText, context),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '' && issueKeyText !== '',
      queryKey: issueKey(workspaceId, issueKeyText),
      auth,
    }
  );

  if (issue === null && isLoading) return <PreviewSkeleton />;
  if (issue === null || workspace === null) {
    return (
      <p className="p-3 text-xs text-text-muted">
        <span className="font-mono">{issueKeyText}</span> was not found, or you
        do not have access to it.
      </p>
    );
  }
  return (
    <Link
      to={issuePath(workspace.slug, issue.key)}
      tabIndex={-1}
      aria-label={`Open ${issue.key} ${issue.title}`}
      onClick={onOpen}
      className="block text-text no-underline transition-colors duration-100 hover:bg-surface"
    >
      <PreviewBody workspaceId={workspaceId} issue={issue} />
    </Link>
  );
};

/** The floating card for a controller, previewing the issue `keyOf` names. */
export const IssueHoverCardPanel: React.FC<{
  controller: HoverCardController;
  keyOf: (anchor: HTMLElement) => string;
}> = ({ controller, keyOf }) => (
  <HoverCardPanel controller={controller}>
    {(anchor) => (
      <IssuePreview issueKeyText={keyOf(anchor)} onOpen={controller.close} />
    )}
  </HoverCardPanel>
);

/** What a trigger spreads and the card it renders beside itself. */
export interface IssueHoverCard {
  triggerProps: HoverCardTriggerProps;
  card: React.ReactNode;
}

/**
 * Wires one issue reference to a hover card for `key`. The trigger also warms
 * the issue's read on hover, so the card usually opens on cached data.
 */
export const useIssueHoverCard = (key: string): IssueHoverCard => {
  const controller = useHoverCard();
  const prefetch = useIssuePrefetch(key);
  const base = hoverCardTriggerProps(controller);
  return {
    triggerProps: {
      ...base,
      onPointerEnter: (event) => {
        if (event.pointerType !== 'touch' && canHover())
          prefetch.onMouseEnter();
        base.onPointerEnter(event);
      },
      onPointerLeave: () => {
        prefetch.onMouseLeave();
        base.onPointerLeave();
      },
    },
    card: <IssueHoverCardPanel controller={controller} keyOf={() => key} />,
  };
};

/** The issue key a delegated reference carries. */
const delegatedKey = (anchor: HTMLElement): string =>
  anchor.getAttribute(ISSUE_KEY_ATTRIBUTE) ?? '';

/**
 * Opens hover cards for the references inside `container` that match
 * `selector`, for a surface that draws them outside React. Returns the card.
 */
export const useDelegatedIssueHoverCard = (
  container: React.RefObject<HTMLElement | null>,
  selector: string
): React.ReactNode => {
  const controller = useHoverCard();
  const { open, leave, dismiss, close } = controller;

  useEffect(() => {
    const root = container.current;
    if (root === null) return;
    const referenceOf = (target: EventTarget | null): HTMLElement | null =>
      target instanceof Element
        ? (target.closest<HTMLElement>(selector) ?? null)
        : null;
    const onOver = (event: PointerEvent): void => {
      if (event.pointerType === 'touch' || !canHover()) return;
      const reference = referenceOf(event.target);
      if (reference !== null && root.contains(reference)) open(reference);
    };
    const onOut = (event: PointerEvent): void => {
      const reference = referenceOf(event.target);
      if (reference === null) return;
      if (referenceOf(event.relatedTarget) === reference) return;
      leave();
    };
    const onDown = (event: PointerEvent): void => {
      if (referenceOf(event.target) === null) close();
      else dismiss();
    };
    root.addEventListener('pointerover', onOver);
    root.addEventListener('pointerout', onOut);
    root.addEventListener('pointerdown', onDown);
    return () => {
      root.removeEventListener('pointerover', onOver);
      root.removeEventListener('pointerout', onOut);
      root.removeEventListener('pointerdown', onDown);
    };
  }, [container, selector, open, leave, dismiss, close]);

  return <IssueHoverCardPanel controller={controller} keyOf={delegatedKey} />;
};

/** Props for IssueHoverTrigger: the issue and how to render the trigger. */
export interface IssueHoverTriggerProps {
  issueKey: string;
  /** Renders the trigger, given the props it spreads. */
  children: (props: HoverCardTriggerProps) => React.ReactNode;
}

/** Gives one rendered trigger a hover card, for rows that map many issues. */
export const IssueHoverTrigger: React.FC<IssueHoverTriggerProps> = ({
  issueKey: key,
  children,
}) => {
  const { triggerProps, card } = useIssueHoverCard(key);
  return (
    <>
      {children(triggerProps)}
      {card}
    </>
  );
};
