/**
 * Opening the issue in view in a coding tool on the person's machine: Cmd or
 * Ctrl+Alt+O hands it to their default tool at once, and "Open in coding
 * tool" in the issue menu and the command palette lists every supported tool
 * to pick from, the default marked. What each tool receives is built in
 * {@link openInCodingTool}, in the browser, from the issue alone.
 */

import React from 'react';
import { LuTerminal } from 'react-icons/lu';
import { useShortcut } from '../../hooks/useShortcuts';
import {
  CODING_TOOLS,
  OPEN_IN_CODING_TOOL_KEYS,
  OPEN_IN_CODING_TOOL_LABEL,
  codingTool,
  openInCodingTool,
  useDefaultCodingTool,
  type CodingToolId,
} from '../../lib/codingTools';
import { issueUrl } from '../../lib/copyIssue';
import { gitBranchName, type BranchNaming } from '../../lib/gitBranch';
import type { IssueRead } from '../../types/Api';
import { Combobox } from '../ui/combobox';
import Dialog from '../ui/dialog';

/** Props for OpenInCodingTool. */
export interface OpenInCodingToolProps {
  slug: string;
  issue: Pick<IssueRead, 'key' | 'title' | 'body'>;
  /** The workspace's branch format and the person's handle. */
  branchNaming: BranchNaming;
  /** Whether the tool picker is open, held by the page so its menu can open it. */
  picking: boolean;
  onPickingChange: (open: boolean) => void;
}

/** The issue's keys and palette commands for coding tools, and the picker they open. */
export const OpenInCodingTool: React.FC<OpenInCodingToolProps> = ({
  slug,
  issue,
  branchNaming,
  picking,
  onPickingChange,
}) => {
  const defaultTool = useDefaultCodingTool();

  const open = (id: CodingToolId): void => {
    openInCodingTool(id, {
      key: issue.key,
      title: issue.title,
      url: issueUrl(slug, issue.key),
      branch: gitBranchName(issue.key, issue.title, branchNaming),
      body: issue.body,
    });
  };

  useShortcut({
    keys: OPEN_IN_CODING_TOOL_KEYS,
    label: `Open in ${codingTool(defaultTool).name}`,
    scope: 'issue',
    group: 'Issue',
    handler: (event) => {
      event?.preventDefault();
      open(defaultTool);
    },
  });

  useShortcut({
    keys: '',
    label: `${OPEN_IN_CODING_TOOL_LABEL}…`,
    scope: 'issue',
    group: 'Issue',
    handler: () => {
      onPickingChange(true);
    },
  });

  if (!picking) return null;

  const close = (): void => {
    onPickingChange(false);
  };

  return (
    <Dialog
      open
      onClose={close}
      title={`${OPEN_IN_CODING_TOOL_LABEL}, ${issue.key}`}
      hideTitle
      size="sm"
    >
      <div className="-mx-4 -mt-8 -mb-4">
        <p className="border-b border-line px-3 pt-2.5 pb-2 text-xs text-text-muted">
          <span className="rounded-sm bg-raised px-1.5 py-0.5 font-mono text-2xs text-text">
            {issue.key}
          </span>
        </p>
        <Combobox
          label={OPEN_IN_CODING_TOOL_LABEL}
          placeholder={`${OPEN_IN_CODING_TOOL_LABEL}...`}
          options={CODING_TOOLS.map((tool) => ({
            value: tool.id,
            label: tool.name,
            icon: <LuTerminal aria-hidden="true" className="h-3.5 w-3.5" />,
            detail:
              tool.id === defaultTool ? `${tool.detail}, default` : tool.detail,
          }))}
          selected={[defaultTool]}
          onSelect={(value) => {
            const tool = CODING_TOOLS.find((item) => item.id === value);
            close();
            if (tool !== undefined) open(tool.id);
          }}
        />
      </div>
    </Dialog>
  );
};

export default OpenInCodingTool;
