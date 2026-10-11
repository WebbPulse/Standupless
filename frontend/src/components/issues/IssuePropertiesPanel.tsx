/**
 * The compact properties panel beside an issue's column. Status, priority,
 * assignee and team are icon and value rows with no label column, because
 * the icon already says which property a row is; labels, project and cycle
 * follow as small sections. Everything that most issues leave empty, the
 * estimate, the dates, the parent, relations, links, pull requests and
 * releases, appears only once it holds something, or when the "+" menu asks
 * for it, so a fresh issue reads as four rows rather than a form. Subscribers
 * always show, so the subscribe toggle is never hidden.
 *
 * Every row is the same inline picker the rest of the app uses, writing
 * through the page's optimistic update, and the keyboard commands bound by the
 * page keep working whether a row is showing or not.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  LuArrowLeftRight,
  LuCalendar,
  LuCalendarClock,
  LuCornerLeftUp,
  LuLink2,
  LuListTree,
  LuPaperclip,
  LuPlus,
  LuTriangle,
} from 'react-icons/lu';
import type { IssueSubscription } from '../../hooks/useIssueSubscription';
import { cn } from '../../lib/cn';
import { timestampLabel } from '../../lib/issueDisplay';
import type { Assignable } from '../../lib/issuePeople';
import { projectPatch } from '../../lib/milestones';
import { liveSlaStatus } from '../../lib/sla';
import type { EstimateOptions } from '../../lib/validation';
import type {
  CycleRead,
  IssueRead,
  IssueUpdate,
  LabelRead,
  LinkRead,
  ProjectRead,
  StatusRead,
  TeamRead,
} from '../../types/Api';
import { IconButton } from '../ui/button';
import Menu, { MenuItem, MenuSeparator } from '../ui/menu';
import GithubIssueSection from './GithubIssueSection';
import GithubLinksSection from './GithubLinksSection';
import IssueDocumentsSection from './IssueDocumentsSection';
import IssueParent from './IssueParent';
import IssueRelations from './IssueRelations';
import IssueReleasesSection from './IssueReleasesSection';
import IssueResources from './IssueResources';
import IssueSubscribers from './IssueSubscribers';
import { IssueTeamRow } from './MoveIssueDialog';
import { IssueMilestonePicker } from './PlanningPickers';
import {
  AssigneePicker,
  CyclePicker,
  DatePicker,
  EstimatePicker,
  LabelsPicker,
  PriorityPicker,
  ProjectPicker,
  StatusPicker,
} from './PropertyPickers';
import SlaBadge from './SlaBadge';

/** A long-tail property the "+" menu can bring into view before it is set. */
type RevealField = 'estimate' | 'startDate' | 'dueDate' | 'parent';

/** The picker each revealed field opens, found by its accessible name. */
const REVEAL_TRIGGER: Record<RevealField, string> = {
  estimate: 'Estimate:',
  startDate: 'Start date:',
  dueDate: 'Due date:',
  parent: 'Parent:',
};

/** Props for IssuePropertiesPanel. */
export interface IssuePropertiesPanelProps {
  workspaceId: string;
  slug: string;
  issue: IssueRead;
  team: TeamRead;
  teams: TeamRead[];
  estimateOptions: EstimateOptions;
  statuses: StatusRead[];
  labels: LabelRead[];
  people: Assignable[];
  /** Candidate parents, already narrowed to the same team. */
  parents: IssueRead[];
  projects: ProjectRead[];
  cycles: CycleRead[];
  links: LinkRead[];
  canEdit: boolean;
  /** Whether the caller may run the issue's commands, such as moving it. */
  canAct: boolean;
  isAdmin: boolean;
  currentUserId: string;
  /** Attachment ids already shown in the description or a comment. */
  hiddenIds: Set<string>;
  onUpdate: (patch: IssueUpdate) => void;
  onCreateLabel?: (name: string) => Promise<LabelRead | null>;
  onMove: () => void;
  onAddSubIssue: () => void;
  onAddRelation: () => void;
  onAddLink: () => void;
  onAttachFiles: (files: File[]) => void;
  /** The caller's subscription, shared with the issue bar's bell. */
  subscription: IssueSubscription;
  className?: string;
}

/** A small titled group in the panel. */
const PanelSection: React.FC<{ title: string; children: React.ReactNode }> = ({
  title,
  children,
}) => (
  <section aria-label={title} className="pt-2">
    <h3 className="px-2 pb-0.5 text-2xs font-medium text-text-faint">
      {title}
    </h3>
    {children}
  </section>
);

/** The panel of an issue's properties, compact until something is set. */
export const IssuePropertiesPanel: React.FC<IssuePropertiesPanelProps> = ({
  workspaceId,
  slug,
  issue,
  team,
  teams,
  estimateOptions,
  statuses,
  labels,
  people,
  parents,
  projects,
  cycles,
  links,
  canEdit,
  canAct,
  isAdmin,
  currentUserId,
  hiddenIds,
  onUpdate,
  onCreateLabel,
  onMove,
  onAddSubIssue,
  onAddRelation,
  onAddLink,
  onAttachFiles,
  subscription,
  className = '',
}) => {
  const panel = useRef<HTMLElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const [revealed, setRevealed] = useState<{
    issueId: string;
    fields: RevealField[];
  }>({ issueId: issue.id, fields: [] });
  const [opening, setOpening] = useState<RevealField | null>(null);

  const shown = (field: RevealField): boolean =>
    revealed.issueId === issue.id && revealed.fields.includes(field);

  const reveal = (field: RevealField): void => {
    setRevealed((held) => ({
      issueId: issue.id,
      fields: held.issueId === issue.id ? [...held.fields, field] : [field],
    }));
    setOpening(field);
  };

  useEffect(() => {
    if (opening === null) return;
    const timer = setTimeout(() => {
      const trigger = panel.current?.querySelector<HTMLButtonElement>(
        `button[aria-label^="${REVEAL_TRIGGER[opening]}"]`
      );
      trigger?.focus();
      trigger?.click();
      setTimeout(() => {
        const panelId = trigger?.getAttribute('aria-controls') ?? null;
        const opened =
          panelId === null ? null : document.getElementById(panelId);
        if (opened !== null && !opened.contains(document.activeElement)) {
          opened
            .querySelector<HTMLElement>('input, button, [tabindex="0"]')
            ?.focus();
        }
      }, 0);
      setOpening(null);
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [opening]);

  const disabled = !canEdit;
  const scaleOn = team.estimate_scale !== 'off';
  const showEstimate =
    issue.estimate !== null || (scaleOn && shown('estimate'));
  const showStart = issue.start_date !== null || shown('startDate');
  const showDue = issue.due_date !== null || shown('dueDate');
  const showParent = issue.parent_id !== null || shown('parent');

  const addMenu = canAct ? (
    <>
      <input
        ref={filePicker}
        type="file"
        multiple
        hidden
        aria-hidden="true"
        tabIndex={-1}
        data-testid="panel-file-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length > 0) onAttachFiles(files);
        }}
      />
      <Menu
        label="Add property"
        align="end"
        trigger={(props) => (
          <IconButton
            label="Add property"
            size="sm"
            className="h-6 w-6"
            {...props}
          >
            <LuPlus className="h-3.5 w-3.5" />
          </IconButton>
        )}
      >
        {scaleOn && !showEstimate && (
          <MenuItem
            onSelect={() => {
              reveal('estimate');
            }}
          >
            <LuTriangle aria-hidden="true" className="h-3.5 w-3.5" />
            Estimate
          </MenuItem>
        )}
        {!showStart && (
          <MenuItem
            onSelect={() => {
              reveal('startDate');
            }}
          >
            <LuCalendar aria-hidden="true" className="h-3.5 w-3.5" />
            Start date
          </MenuItem>
        )}
        {!showDue && (
          <MenuItem
            onSelect={() => {
              reveal('dueDate');
            }}
          >
            <LuCalendarClock aria-hidden="true" className="h-3.5 w-3.5" />
            Due date
          </MenuItem>
        )}
        {!showParent && (
          <MenuItem
            onSelect={() => {
              reveal('parent');
            }}
          >
            <LuCornerLeftUp aria-hidden="true" className="h-3.5 w-3.5" />
            Parent
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem onSelect={onAddSubIssue}>
          <LuListTree aria-hidden="true" className="h-3.5 w-3.5" />
          Sub-issue
        </MenuItem>
        <MenuItem onSelect={onAddRelation}>
          <LuArrowLeftRight aria-hidden="true" className="h-3.5 w-3.5" />
          Relation
        </MenuItem>
        <MenuItem onSelect={onAddLink}>
          <LuLink2 aria-hidden="true" className="h-3.5 w-3.5" />
          Link
        </MenuItem>
        <MenuItem
          onSelect={() => {
            filePicker.current?.click();
          }}
        >
          <LuPaperclip aria-hidden="true" className="h-3.5 w-3.5" />
          File
        </MenuItem>
      </Menu>
    </>
  ) : null;

  return (
    <aside
      ref={panel}
      aria-label="Properties"
      className={cn(
        'w-full shrink-0 rounded-lg border border-line bg-surface p-2 text-sm',
        className
      )}
    >
      <div className="flex h-6 items-center justify-between pb-0.5">
        <h2 className="px-2 text-2xs font-medium text-text-faint">
          Properties
        </h2>
        {addMenu}
      </div>

      <div className="space-y-px">
        <StatusPicker
          disabled={disabled}
          statuses={statuses}
          value={issue.status_id}
          onChange={(statusId) => {
            onUpdate({ status_id: statusId });
          }}
        />
        <PriorityPicker
          disabled={disabled}
          value={issue.priority}
          onChange={(priority) => {
            onUpdate({ priority });
          }}
        />
        <AssigneePicker
          disabled={disabled}
          people={people}
          value={issue.assignee_id}
          currentUserId={currentUserId}
          onChange={(assigneeId) => {
            onUpdate({ assignee_id: assigneeId });
          }}
        />
        <IssueTeamRow team={team} canMove={canAct} onMove={onMove} />
        {showEstimate && (
          <EstimatePicker
            disabled={disabled}
            scale={team.estimate_scale}
            extended={estimateOptions.extended ?? false}
            allowZero={estimateOptions.allowZero ?? false}
            value={issue.estimate}
            onChange={(estimate) => {
              onUpdate({ estimate });
            }}
          />
        )}
        {showStart && (
          <DatePicker
            disabled={disabled}
            field="Start date"
            value={issue.start_date}
            {...(issue.due_date === null ? {} : { max: issue.due_date })}
            onChange={(startDate) => {
              onUpdate({ start_date: startDate });
            }}
          />
        )}
        {showDue && (
          <DatePicker
            disabled={disabled}
            field="Due date"
            value={issue.due_date}
            {...(issue.start_date === null ? {} : { min: issue.start_date })}
            onChange={(dueDate) => {
              onUpdate({ due_date: dueDate });
            }}
          />
        )}
        {liveSlaStatus(issue) !== 'none' && (
          <div className="flex min-h-7 items-center px-2">
            <SlaBadge issue={issue} />
          </div>
        )}
      </div>

      <PanelSection title="Labels">
        <LabelsPicker
          disabled={disabled}
          labels={labels}
          value={issue.label_ids}
          {...(onCreateLabel === undefined ? {} : { onCreate: onCreateLabel })}
          onChange={(labelIds) => {
            onUpdate({ label_ids: labelIds });
          }}
        />
      </PanelSection>

      <PanelSection title="Project">
        <ProjectPicker
          disabled={disabled}
          projects={projects}
          value={issue.project_id}
          onChange={(projectId) => {
            onUpdate(projectPatch(issue, projectId));
          }}
        />
        {issue.project_id !== null && (
          <IssueMilestonePicker
            workspaceId={workspaceId}
            projectId={issue.project_id}
            value={issue.project_milestone_id ?? null}
            disabled={disabled}
            onChange={(milestoneId) => {
              onUpdate({ project_milestone_id: milestoneId });
            }}
          />
        )}
      </PanelSection>

      <PanelSection title="Cycle">
        <CyclePicker
          disabled={disabled}
          cycles={cycles}
          value={issue.cycle_id}
          onChange={(cycleId) => {
            onUpdate({ cycle_id: cycleId });
          }}
        />
      </PanelSection>

      <div className="mt-2 space-y-2 border-t border-line px-1 pt-2 empty:hidden [&>section:last-child]:border-b-0 [&>section:last-child]:pb-0">
        <GithubIssueSection workspaceId={workspaceId} issueId={issue.id} />
        <IssueParent
          workspaceId={workspaceId}
          slug={slug}
          issue={issue}
          candidates={parents}
          statuses={statuses}
          canEdit={canEdit}
          hideEmpty={!shown('parent')}
          onChange={(parentId) => {
            onUpdate({ parent_id: parentId });
          }}
        />
        <IssueRelations
          workspaceId={workspaceId}
          issueId={issue.id}
          slug={slug}
          links={links}
          canEdit={canEdit}
          hideEmpty
          onAdd={onAddRelation}
        />
        <IssueResources
          workspaceId={workspaceId}
          issueId={issue.id}
          currentUserId={currentUserId}
          canEdit={canEdit}
          isAdmin={isAdmin}
          hiddenIds={hiddenIds}
          hideEmpty
          onAddLink={onAddLink}
          onAttachFiles={onAttachFiles}
        />
        <GithubLinksSection
          workspaceId={workspaceId}
          issueId={issue.id}
          issueKey={issue.key}
          title={issue.title}
        />
        <IssueReleasesSection
          workspaceId={workspaceId}
          issueId={issue.id}
          slug={slug}
          teams={teams}
        />
        <IssueDocumentsSection
          workspaceId={workspaceId}
          issueId={issue.id}
          slug={slug}
        />
        <IssueSubscribers
          subscription={subscription}
          people={people}
          currentUserId={currentUserId}
        />
      </div>

      <p className="px-2 pt-2 text-2xs text-text-faint">
        Updated {timestampLabel(issue.updated_at)}
      </p>
    </aside>
  );
};

export default IssuePropertiesPanel;
