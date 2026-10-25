/**
 * The workspace's git branch name format, on the GitHub side of the
 * integrations page as Linear keeps it: the key and title, the copier's
 * username then the key and title, or the key alone. Every format keeps the
 * key, so a pull request from any of them still links its issue. The preview
 * shows what the person looking would copy for an example issue.
 */

import React, { useState } from 'react';
import { updateWorkspace } from '../../api/workspaces';
import { useWorkspace } from '../../hooks/useWorkspace';
import {
  BRANCH_FORMATS,
  DEFAULT_BRANCH_FORMAT,
  gitBranchName,
  type BranchFormat,
} from '../../lib/gitBranch';
import type { WorkspaceRead } from '../../types/Api';
import { SelectField } from '../ui/select';

/** The title the preview is built from. */
const EXAMPLE_TITLE = 'Fix the login redirect';

/** Props for BranchFormatSection. */
export interface BranchFormatSectionProps {
  workspace: WorkspaceRead;
  /** The viewer's handle, which the username format leads with. */
  handle: string;
  /** The key the preview names, such as ENG-123. */
  exampleKey: string;
}

/** Picks the branch format, saves it, then re-reads the workspace. */
export const BranchFormatSection: React.FC<BranchFormatSectionProps> = ({
  workspace,
  handle,
  exampleKey,
}) => {
  const { refresh } = useWorkspace();
  const saved = workspace.branch_format ?? DEFAULT_BRANCH_FORMAT;
  const [value, setValue] = useState<BranchFormat>(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = saving ? value : saved;

  const save = async (format: BranchFormat): Promise<void> => {
    setValue(format);
    setSaving(true);
    setError(null);
    try {
      await updateWorkspace(workspace.id, { branch_format: format });
      await refresh();
    } catch {
      setError('Could not save the branch format. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const preview = gitBranchName(exampleKey, EXAMPLE_TITLE, {
    format: shown,
    handle: handle === '' ? 'username' : handle,
  });

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Git branch names</h3>
        <p className="text-sm text-text-muted">
          The format every member copies with Copy git branch name. Each format
          keeps the issue identifier, so pull requests from it still link to the
          issue.
        </p>
      </div>
      <SelectField
        id="workspace-branch-format"
        label="Branch format"
        className="max-w-xs"
        value={shown}
        disabled={saving}
        onChange={(event) => {
          void save(event.target.value as BranchFormat);
        }}
      >
        {BRANCH_FORMATS.map((format) => (
          <option key={format.value} value={format.value}>
            {format.label}
          </option>
        ))}
      </SelectField>
      <p className="text-sm text-text-muted">
        Preview:{' '}
        <code
          data-testid="branch-format-preview"
          className="rounded-sm bg-raised px-1 py-0.5 font-mono text-xs text-text"
        >
          {preview}
        </code>
      </p>
      {error !== null && <p className="text-sm text-danger">{error}</p>}
    </section>
  );
};

export default BranchFormatSection;
