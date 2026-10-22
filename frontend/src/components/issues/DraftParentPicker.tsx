/**
 * The parent chip of the new issue dialog. It searches the team's top level
 * issues on the server as the person types, through the same search the set
 * parent dialog uses, and reads nothing until it is opened. The draft has no
 * issue of its own yet, so the chip holds the picked parent's key and title
 * to show after the search moves on.
 */

import React, { useState } from 'react';
import { LuCornerUpLeft, LuX } from 'react-icons/lu';
import { useParentSearch } from '../../hooks/useParentSearch';
import { Combobox, type ComboboxOption } from '../ui/combobox';
import { Popover } from '../ui/popover';
import { PickerButton } from './PropertyPickers';

/** The parent a draft is filed under, as the chip shows it. */
export interface DraftParent {
  id: string;
  key: string;
  title: string;
}

/** Props for DraftParentPicker. */
export interface DraftParentPickerProps {
  workspaceId: string;
  /** The team the draft lands in; sub-issues share their parent's team. */
  teamId: string;
  value: DraftParent | null;
  onChange: (parent: DraftParent | null) => void;
}

/** The value of the row that clears the parent. */
const NONE = '';

/** The search list, mounted only while the popover is open. */
const ParentSearchList: React.FC<
  DraftParentPickerProps & { close: () => void }
> = ({ workspaceId, teamId, value, onChange, close }) => {
  const [query, setQuery] = useState('');
  const found = useParentSearch(workspaceId, teamId, query);
  const options: ComboboxOption[] = [
    ...(value === null
      ? []
      : [
          {
            value: NONE,
            label: 'No parent',
            icon: <LuX className="h-3.5 w-3.5 text-text-faint" />,
          },
        ]),
    ...(found ?? []).map((candidate) => ({
      value: candidate.id,
      label: candidate.title,
      detail: candidate.key,
      keywords: [candidate.key],
      icon: <LuCornerUpLeft className="h-3.5 w-3.5 text-text-faint" />,
    })),
  ];
  return (
    <Combobox
      label="Parent"
      placeholder="Set parent issue..."
      options={options}
      selected={[value?.id ?? NONE]}
      emptyMessage={
        found === null
          ? 'Searching...'
          : 'No top level issue in this team matches.'
      }
      onQueryChange={setQuery}
      onSelect={(picked) => {
        close();
        if (picked === NONE) {
          onChange(null);
          return;
        }
        const candidate = found?.find((issue) => issue.id === picked);
        if (candidate !== undefined && candidate.id !== value?.id) {
          onChange({
            id: candidate.id,
            key: candidate.key,
            title: candidate.title,
          });
        }
      }}
    />
  );
};

/** Picks the parent a new issue is filed under. */
export const DraftParentPicker: React.FC<DraftParentPickerProps> = (props) => {
  const { value } = props;
  const text =
    value === null
      ? 'Parent'
      : value.title === ''
        ? value.key
        : `${value.key} ${value.title}`;
  return (
    <Popover
      label="Parent"
      contentClassName="w-72"
      trigger={(trigger) => (
        <PickerButton
          trigger={trigger}
          field="Parent"
          icon={<LuCornerUpLeft className="h-3.5 w-3.5" />}
          text={text}
          empty={value === null}
          variant="chip"
          disabled={false}
          className=""
        />
      )}
    >
      {(close) => <ParentSearchList {...props} close={close} />}
    </Popover>
  );
};

export default DraftParentPicker;
