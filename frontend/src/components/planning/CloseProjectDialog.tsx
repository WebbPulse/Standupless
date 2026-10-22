/**
 * The question a project close asks when issues are still open in it, as
 * Linear does: keep them in the project, move them to another open project,
 * or cancel them. The choice rides on the same status patch, so the close and
 * the sweep land together or not at all.
 */

import React, { useId, useState } from 'react';
import { cn } from '../../lib/cn';
import type {
  ProjectOpenIssues,
  ProjectOpenIssuesAction,
  ProjectRead,
} from '../../types/Api';
import Button from '../ui/button';
import Dialog from '../ui/dialog';
import Select from '../ui/select';

/** The two statuses that close a project. */
export type ClosingStatus = 'completed' | 'canceled';

/** Props for CloseProjectDialog: the project, the close and the move targets. */
export interface CloseProjectDialogProps {
  project: ProjectRead;
  status: ClosingStatus;
  openIssues: number;
  /** Open projects the issues may move to, the closing one already left out. */
  targets: ProjectRead[];
  onConfirm: (choice: ProjectOpenIssues) => void;
  onClose: () => void;
}

const CHOICES: { action: ProjectOpenIssuesAction; label: string }[] = [
  { action: 'keep', label: 'Keep them in this project' },
  { action: 'move', label: 'Move them to another project' },
  { action: 'cancel', label: 'Cancel them' },
];

/** Asks what to do with a closing project's open issues before the close is sent. */
const CloseProjectDialog: React.FC<CloseProjectDialogProps> = ({
  project,
  status,
  openIssues,
  targets,
  onConfirm,
  onClose,
}) => {
  const name = useId();
  const [action, setAction] = useState<ProjectOpenIssuesAction>('keep');
  const [target, setTarget] = useState('');
  const verb = status === 'completed' ? 'Complete' : 'Cancel';
  const noun = openIssues === 1 ? 'issue' : 'issues';
  const ready = action !== 'move' || target !== '';

  const confirm = () => {
    if (!ready) return;
    onConfirm(action === 'move' ? { action, project_id: target } : { action });
  };

  return (
    <Dialog
      open
      size="sm"
      title={`${verb} ${project.name}`}
      description={`${String(openIssues)} ${noun} in this project ${openIssues === 1 ? 'is' : 'are'} still open. What should happen to ${openIssues === 1 ? 'it' : 'them'}?`}
      onClose={onClose}
    >
      <div className="space-y-4">
        <fieldset className="space-y-1">
          <legend className="sr-only">Open issues</legend>
          {CHOICES.map((choice) => (
            <label
              key={choice.action}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text hover:bg-surface',
                choice.action === 'move' &&
                  targets.length === 0 &&
                  'cursor-not-allowed text-text-faint hover:bg-transparent'
              )}
            >
              <input
                type="radio"
                name={name}
                value={choice.action}
                checked={action === choice.action}
                disabled={choice.action === 'move' && targets.length === 0}
                onChange={() => {
                  setAction(choice.action);
                }}
                className="accent-accent"
              />
              {choice.label}
            </label>
          ))}
          {action === 'move' && (
            <div className="pt-1 pl-6">
              <Select
                aria-label="Move to project"
                value={target}
                onChange={(event) => {
                  setTarget(event.target.value);
                }}
              >
                <option value="" disabled>
                  Choose a project
                </option>
                {targets.map((option) => (
                  <option key={option.project_id} value={option.project_id}>
                    {option.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </fieldset>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Back
          </Button>
          <Button
            variant={status === 'canceled' ? 'danger' : 'primary'}
            disabled={!ready}
            onClick={confirm}
          >
            {`${verb} project`}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};

export default CloseProjectDialog;
