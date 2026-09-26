/**
 * A static picture of the app for the home page, drawn from the same glyphs,
 * chips and avatars the real issue list uses so the preview cannot drift into
 * showing something the product does not look like. Nothing in it is live and
 * it is hidden from assistive technology as a whole, with one sentence
 * describing it instead.
 */

import React from 'react';
import {
  LuChevronDown,
  LuInbox,
  LuLayers,
  LuMap,
  LuSearch,
  LuSquarePen,
  LuTarget,
  LuUserRound,
} from 'react-icons/lu';
import { Logo } from '../../brand';
import Avatar from '../../components/ui/avatar';
import { LabelChip } from '../../components/ui/badge';
import { PriorityGlyph, StatusGlyph } from '../../components/ui/glyphs';
import { cn } from '../../lib/cn';
import type { IssuePriority, StatusCategory } from '../../types/Api';

/** One label in the preview. */
interface PreviewLabel {
  name: string;
  color: string;
}

/** One issue row in the preview. */
interface PreviewIssue {
  key: string;
  title: string;
  priority: IssuePriority;
  labels: PreviewLabel[];
  assignee: string;
  estimate?: string;
}

/** One status group in the preview. */
interface PreviewGroup {
  name: string;
  category: StatusCategory;
  issues: PreviewIssue[];
}

const BUG: PreviewLabel = { name: 'Bug', color: '#e5484d' };
const FEATURE: PreviewLabel = { name: 'Feature', color: '#8e7cf0' };
const IMPROVEMENT: PreviewLabel = { name: 'Improvement', color: '#3e9bef' };

const GROUPS: PreviewGroup[] = [
  {
    name: 'In Progress',
    category: 'started',
    issues: [
      {
        key: 'ENG-214',
        title: 'Rate limit the public search endpoint',
        priority: 'urgent',
        labels: [IMPROVEMENT],
        assignee: 'Maya Chen',
        estimate: '3',
      },
      {
        key: 'ENG-209',
        title: 'Date picker overflows on small screens',
        priority: 'high',
        labels: [BUG],
        assignee: 'Sam Ortiz',
        estimate: '1',
      },
      {
        key: 'ENG-201',
        title: 'Export the audit log as CSV',
        priority: 'medium',
        labels: [FEATURE],
        assignee: 'Priya Nair',
        estimate: '5',
      },
    ],
  },
  {
    name: 'Todo',
    category: 'unstarted',
    issues: [
      {
        key: 'ENG-218',
        title: 'Retry failed invoice emails with backoff',
        priority: 'high',
        labels: [IMPROVEMENT],
        assignee: 'Jonas Weber',
        estimate: '2',
      },
      {
        key: 'ENG-217',
        title: 'Flaky checkout test on the CI runner',
        priority: 'medium',
        labels: [BUG],
        assignee: 'Maya Chen',
      },
      {
        key: 'ENG-212',
        title: 'Upgrade the web app to the latest Node LTS',
        priority: 'low',
        labels: [],
        assignee: 'Sam Ortiz',
        estimate: '3',
      },
    ],
  },
  {
    name: 'Done',
    category: 'completed',
    issues: [
      {
        key: 'ENG-198',
        title: 'Onboarding checklist for new workspaces',
        priority: 'medium',
        labels: [FEATURE],
        assignee: 'Priya Nair',
        estimate: '3',
      },
    ],
  },
];

/** One sidebar entry in the preview. */
const SideItem: React.FC<{
  icon?: React.ReactNode;
  children: React.ReactNode;
  active?: boolean;
  trailing?: React.ReactNode;
  indent?: boolean;
}> = ({ icon, children, active = false, trailing, indent = false }) => (
  <div
    className={cn(
      'flex h-7 items-center gap-2 rounded-sm px-2 text-xs',
      indent && 'pl-7',
      active ? 'bg-raised text-text' : 'text-text-muted'
    )}
  >
    {icon}
    <span className="flex-1 truncate">{children}</span>
    {trailing}
  </div>
);

const ICON = 'h-3.5 w-3.5 shrink-0';

/** The sidebar half of the preview. */
const PreviewSidebar: React.FC = () => (
  <div className="hidden w-52 shrink-0 flex-col gap-3 border-r border-line bg-surface p-2 md:flex">
    <div className="flex items-center gap-2 px-2 pt-1">
      <span className="flex h-5 w-5 items-center justify-center rounded-xs bg-accent text-[10px] font-semibold text-on-accent">
        A
      </span>
      <span className="flex-1 truncate text-xs font-semibold text-text">
        Acme
      </span>
      <LuSearch className={cn(ICON, 'text-text-faint')} />
      <LuSquarePen className={cn(ICON, 'text-text-faint')} />
    </div>
    <div className="space-y-px">
      <SideItem
        icon={<LuInbox className={ICON} />}
        trailing={
          <span className="rounded-full bg-accent-soft px-1.5 text-[10px] text-accent">
            3
          </span>
        }
      >
        Inbox
      </SideItem>
      <SideItem icon={<LuUserRound className={ICON} />}>My issues</SideItem>
    </div>
    <div className="space-y-px">
      <p className="px-2 pb-1 text-[10px] font-medium text-text-faint">
        Workspace
      </p>
      <SideItem icon={<LuLayers className={ICON} />}>Projects</SideItem>
      <SideItem icon={<LuMap className={ICON} />}>Roadmap</SideItem>
      <SideItem icon={<LuTarget className={ICON} />}>Views</SideItem>
    </div>
    <div className="space-y-px">
      <p className="px-2 pb-1 text-[10px] font-medium text-text-faint">
        Your teams
      </p>
      <SideItem
        icon={
          <span className="flex h-3.5 w-3.5 items-center justify-center rounded-xs bg-[#3e9bef] text-[8px] font-semibold text-white">
            E
          </span>
        }
        trailing={<LuChevronDown className="h-3 w-3 text-text-faint" />}
      >
        Engineering
      </SideItem>
      <SideItem indent active>
        Issues
      </SideItem>
      <SideItem indent>Board</SideItem>
      <SideItem indent>Cycles</SideItem>
      <SideItem indent>Projects</SideItem>
      <SideItem
        icon={
          <span className="flex h-3.5 w-3.5 items-center justify-center rounded-xs bg-[#8e7cf0] text-[8px] font-semibold text-white">
            D
          </span>
        }
      >
        Design
      </SideItem>
    </div>
  </div>
);

/** One issue row in the preview, laid out like the real list row. */
const PreviewRow: React.FC<{
  issue: PreviewIssue;
  category: StatusCategory;
}> = ({ issue, category }) => (
  <div className="flex h-9 items-center gap-2.5 border-b border-line px-3 sm:px-4">
    <PriorityGlyph priority={issue.priority} />
    <span className="w-14 shrink-0 font-mono text-[11px] text-text-faint">
      {issue.key}
    </span>
    <StatusGlyph category={category} />
    <span className="min-w-0 flex-1 truncate text-xs font-medium text-text sm:text-[13px]">
      {issue.title}
    </span>
    <span className="flex shrink-0 items-center gap-2">
      {issue.labels.length > 0 && (
        <span className="hidden items-center gap-1 sm:flex">
          {issue.labels.map((label) => (
            <LabelChip key={label.name} color={label.color} name={label.name} />
          ))}
        </span>
      )}
      {issue.estimate !== undefined && (
        <span className="hidden h-5 min-w-5 items-center justify-center rounded-xs border border-line px-1 text-[10px] text-text-muted sm:inline-flex">
          {issue.estimate}
        </span>
      )}
      <Avatar name={issue.assignee} size="xs" />
    </span>
  </div>
);

/** A still of a team's issue list inside the app chrome. */
export const AppPreview: React.FC<{ className?: string }> = ({
  className = '',
}) => (
  <figure className={cn('relative', className)}>
    <figcaption className="sr-only">
      A preview of Standupless showing a team's issues grouped by status, with
      the workspace sidebar beside them.
    </figcaption>
    <div
      aria-hidden="true"
      className="pointer-events-none flex h-[420px] overflow-hidden rounded-lg border border-line-strong bg-bg text-left shadow-[0_24px_80px_-16px_rgba(0,0,0,0.6)] select-none sm:h-[460px]"
    >
      <PreviewSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3 text-xs sm:px-4">
          <Logo size={14} title={null} className="md:hidden" />
          <span className="text-text-muted">Engineering</span>
          <span className="text-text-faint">/</span>
          <span className="font-medium text-text">Issues</span>
          <span className="ml-auto hidden items-center gap-1 sm:flex">
            <span className="rounded-sm border border-line-strong bg-raised px-2 py-0.5 text-[11px] text-text">
              All issues
            </span>
            <span className="px-2 py-0.5 text-[11px] text-text-muted">
              Active
            </span>
            <span className="px-2 py-0.5 text-[11px] text-text-muted">
              Backlog
            </span>
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {GROUPS.map((group) => (
            <div key={group.name}>
              <div className="flex h-8 items-center gap-2 border-b border-line bg-surface px-3 text-xs sm:px-4">
                <StatusGlyph category={group.category} />
                <span className="font-medium text-text">{group.name}</span>
                <span className="text-text-faint">{group.issues.length}</span>
              </div>
              {group.issues.map((issue) => (
                <PreviewRow
                  key={issue.key}
                  issue={issue}
                  category={group.category}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  </figure>
);

export default AppPreview;
