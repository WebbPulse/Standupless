/**
 * The person's interface preferences: where a workspace opens, the first day
 * of the week, whether people read by full name or username, the text size,
 * the colour theme, the code block theme, pointer cursors and emoticon conversion, and the workflow switches: assigning new issues to
 * themselves, and starting and assigning an issue when its git branch name is
 * copied.
 *
 * Everything is stored on the account, so it follows the person to every
 * device and workspace. Each choice saves as soon as it changes and the
 * section keeps the answer the server returns, so a refused change does not
 * leave a picker showing something that is not stored. The theme goes through
 * the same path as the sidebar toggle and the command palette, which paints it
 * at once and saves it to the account behind.
 */

import React, { useId, useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { updatePreferences } from '../../api/notifications';
import { useAuth } from '../../hooks/useAuth';
import { useTheme } from '../../hooks/useTheme';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { preferencesOf } from '../../lib/preferences';
import { CURRENT_USER_KEY } from '../../lib/queryKeys';
import type { Theme } from '../../lib/theme';
import type {
  CodeTheme,
  FontSize,
  HomeView,
  NameDisplay,
  UserPreferencesUpdate,
  WeekStart,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import CodingToolPreference from './CodingToolPreference';
import { Select } from '../ui/select';

/** One choice in a preference picker. */
interface Choice<T extends string> {
  value: T;
  label: string;
}

/** Where a workspace can open, in the order the picker lists them. */
const HOME_VIEW_CHOICES: Choice<HomeView>[] = [
  { value: 'home', label: 'Home' },
  { value: 'inbox', label: 'Inbox' },
  { value: 'my_issues', label: 'My issues' },
  { value: 'projects', label: 'Projects' },
  { value: 'pulse', label: 'Pulse' },
  { value: 'views', label: 'Views' },
];

/** The days a week can start on. */
const WEEK_START_CHOICES: Choice<WeekStart>[] = [
  { value: 'monday', label: 'Monday' },
  { value: 'sunday', label: 'Sunday' },
  { value: 'saturday', label: 'Saturday' },
];

/** How other people's names read. */
const NAME_DISPLAY_CHOICES: Choice<NameDisplay>[] = [
  { value: 'username', label: 'Username' },
  { value: 'full_name', label: 'Full name' },
];

/** The text sizes the interface can draw at. */
const FONT_SIZE_CHOICES: Choice<FontSize>[] = [
  { value: 'small', label: 'Small' },
  { value: 'default', label: 'Default' },
  { value: 'large', label: 'Large' },
];

/** The colour themes, in the order the picker lists them. */
const THEME_CHOICES: Choice<Theme>[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** The syntax highlighting themes for code blocks, in the order the picker lists them. */
const CODE_THEME_CHOICES: Choice<CodeTheme>[] = [
  { value: 'app', label: 'Match app theme' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'light_high_contrast', label: 'Light high contrast' },
  { value: 'dark_high_contrast', label: 'Dark high contrast' },
];

/** Props for PreferenceRow: the label, the help text and the picker. */
interface PreferenceRowProps<T extends string> {
  label: string;
  detail: string;
  value: T;
  choices: Choice<T>[];
  disabled?: boolean;
  onChange: (value: T) => void;
}

/** One labelled picker with a line saying what it changes. */
const PreferenceRow = <T extends string>({
  label,
  detail,
  value,
  choices,
  disabled = false,
  onChange,
}: PreferenceRowProps<T>): React.ReactElement => {
  const id = useId();
  return (
    <div className="space-y-1 border-b border-line p-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-text">
          {label}
        </label>
        <Select
          id={id}
          className="w-48"
          value={value}
          disabled={disabled}
          onChange={(event) => {
            const choice = choices.find(
              (option) => option.value === event.target.value
            );
            if (choice !== undefined) onChange(choice.value);
          }}
        >
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </Select>
      </div>
      <p className="text-xs text-text-faint">{detail}</p>
    </div>
  );
};

/** Props for ToggleRow: the label, the help text and the switch state. */
interface ToggleRowProps {
  label: string;
  detail: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

/** One labelled switch with a line saying what it changes. */
const ToggleRow: React.FC<ToggleRowProps> = ({
  label,
  detail,
  checked,
  disabled = false,
  onChange,
}) => {
  const id = useId();
  return (
    <div className="space-y-1 border-b border-line p-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <span id={id} className="text-sm font-medium text-text">
          {label}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-labelledby={id}
          disabled={disabled}
          onClick={() => {
            onChange(!checked);
          }}
          className={cn(
            'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-transparent transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60',
            checked
              ? 'bg-accent enabled:hover:bg-accent-strong'
              : 'bg-line-strong enabled:hover:bg-text-faint'
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'inline-block h-3 w-3 rounded-full bg-bg shadow-sm transition-transform duration-100',
              checked ? 'translate-x-3' : 'translate-x-0'
            )}
          />
        </button>
      </div>
      <p className="text-xs text-text-faint">{detail}</p>
    </div>
  );
};

/** Renders the caller's interface preferences and saves each change. */
export const PreferencesSection: React.FC = () => {
  const { user, login } = useAuth();
  const { theme, setTheme } = useTheme();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);

  if (user === null) return null;
  const preferences = preferencesOf(user);

  const save = (body: UserPreferencesUpdate): void => {
    setSaving(true);
    setSaveError(null);
    void updatePreferences(body)
      .then((stored) => {
        login(stored);
        invalidateQueries(CURRENT_USER_KEY);
      })
      .catch((failure: unknown) => {
        setSaveError(failure);
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <section aria-labelledby="preferences-heading" className="space-y-4">
      <div className="space-y-1">
        <h2 id="preferences-heading" className="text-base font-semibold">
          Preferences
        </h2>
        <p className="text-sm text-text-muted">
          How Standupless looks and behaves for you. These are yours and apply
          in every workspace you belong to.
        </p>
      </div>

      {saveError !== null && (
        <ErrorAlert
          message={errorMessage(saveError, 'Could not save that change.')}
        />
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-text-muted">General</h3>
        <div className="rounded-md border border-line">
          <PreferenceRow
            label="Default home view"
            detail="The page a workspace opens on when you choose it."
            value={preferences.homeView}
            choices={HOME_VIEW_CHOICES}
            disabled={saving}
            onChange={(value) => {
              save({ home_view: value });
            }}
          />
          <PreferenceRow
            label="First day of the week"
            detail="Where next week starts in date shortcuts, snoozes and the timeline."
            value={preferences.weekStart}
            choices={WEEK_START_CHOICES}
            disabled={saving}
            onChange={(value) => {
              save({ week_start: value });
            }}
          />
          <PreferenceRow
            label="Show people by"
            detail="How assignees, authors and members read. Mentions always use the username."
            value={preferences.nameDisplay}
            choices={NAME_DISPLAY_CHOICES}
            disabled={saving}
            onChange={(value) => {
              save({ name_display: value });
            }}
          />
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-text-muted">Workflow</h3>
        <div className="rounded-md border border-line">
          <ToggleRow
            label="Auto-assign to self"
            detail="New issues you create start assigned to you. You can still change or clear the assignee before creating."
            checked={preferences.autoAssignToSelf}
            disabled={saving}
            onChange={(on) => {
              save({ auto_assign_to_self: on });
            }}
          />
          <ToggleRow
            label="On git branch copy, move issue to started status"
            detail="Copying the branch name of a backlog or unstarted issue moves it to the team's first started status."
            checked={preferences.branchCopyStarts}
            disabled={saving}
            onChange={(on) => {
              save({ branch_copy_starts: on });
            }}
          />
          <ToggleRow
            label="On git branch copy, assign to me"
            detail="Copying the branch name of an unassigned backlog or unstarted issue assigns it to you."
            checked={preferences.branchCopyAssigns}
            disabled={saving}
            onChange={(on) => {
              save({ branch_copy_assigns: on });
            }}
          />
          <CodingToolPreference />
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-text-muted">Interface</h3>
        <div className="rounded-md border border-line">
          <PreferenceRow
            label="Font size"
            detail="The size of text across the interface."
            value={preferences.fontSize}
            choices={FONT_SIZE_CHOICES}
            disabled={saving}
            onChange={(value) => {
              save({ font_size: value });
            }}
          />
          <PreferenceRow
            label="Theme"
            detail="The colour theme on every device you sign in on."
            value={theme}
            choices={THEME_CHOICES}
            onChange={setTheme}
          />
          <PreferenceRow
            label="Code block theme"
            detail="The syntax highlighting colours of code blocks in descriptions, comments, documents and updates."
            value={preferences.codeTheme}
            choices={CODE_THEME_CHOICES}
            disabled={saving}
            onChange={(value) => {
              save({ code_theme: value });
            }}
          />
          <ToggleRow
            label="Use pointer cursors"
            detail="Show the pointer cursor on buttons, menu items, rows and other interactive elements."
            checked={preferences.pointerCursors}
            disabled={saving}
            onChange={(on) => {
              save({ pointer_cursors: on });
            }}
          />
          <ToggleRow
            label="Always underline links"
            detail="Underline links in descriptions, comments and updates, not only on hover."
            checked={preferences.underlineLinks}
            disabled={saving}
            onChange={(on) => {
              save({ underline_links: on });
            }}
          />
          <ToggleRow
            label="Turn emoticons into emoji"
            detail="Typing an emoticon such as :) or <3 followed by a space or punctuation turns it into the emoji while you write."
            checked={preferences.convertEmoticons}
            disabled={saving}
            onChange={(on) => {
              save({ convert_emoticons: on });
            }}
          />
        </div>
      </div>
    </section>
  );
};

export default PreferencesSection;
