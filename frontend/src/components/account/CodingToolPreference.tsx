/**
 * The default coding tool row of the Preferences page: the tool Cmd or
 * Ctrl+Alt+O opens an issue in. Unlike the rows around it this choice is kept
 * in this browser, because the tools installed differ from one machine to the
 * next, so it saves at once and needs no server round trip.
 */

import React, { useId } from 'react';
import { displayKeys } from '../../hooks/useShortcuts';
import {
  CODING_TOOLS,
  OPEN_IN_CODING_TOOL_KEYS,
  setDefaultCodingTool,
  useDefaultCodingTool,
} from '../../lib/codingTools';
import { Select } from '../ui/select';

/** Picks the coding tool the open shortcut uses on this device. */
export const CodingToolPreference: React.FC = () => {
  const id = useId();
  const current = useDefaultCodingTool();
  const keys = displayKeys(OPEN_IN_CODING_TOOL_KEYS)
    .map((step) => step.replace(/ /g, '+'))
    .join(' ');
  return (
    <div className="space-y-1 border-b border-line p-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-text">
          Default coding tool
        </label>
        <Select
          id={id}
          className="w-48"
          value={current}
          onChange={(event) => {
            const tool = CODING_TOOLS.find(
              (option) => option.id === event.target.value
            );
            if (tool !== undefined) setDefaultCodingTool(tool.id);
          }}
        >
          {CODING_TOOLS.map((tool) => (
            <option key={tool.id} value={tool.id}>
              {tool.name}
            </option>
          ))}
        </Select>
      </div>
      <p className="text-xs text-text-faint">
        {`The tool ${keys} opens an issue in, with its branch and a prompt built from the issue. Kept on this device.`}
      </p>
    </div>
  );
};

export default CodingToolPreference;
