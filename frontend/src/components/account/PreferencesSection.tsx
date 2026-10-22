/**
 * The person's interface preferences: where a workspace opens, the first day
 * of the week, whether people read by full name or username, the text size
 * and the colour theme.
 *
 * Everything but the theme is stored on the account, so it follows the person
 * to every device and workspace. Each choice saves as soon as it changes and
 * the section keeps the answer the server returns, so a refused change does
 * not leave a picker showing something that is not stored. The theme is kept
 * in this browser, the way the sidebar toggle and the command palette already
 * set it, so a shared computer can be light while a laptop stays dark.
 */

import React, { useId, useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { updatePreferences } from '../../api/notifications';
import { useAuth } from '../../hooks/useAuth';
import { useTheme } from '../../hooks/useTheme';
import { errorMessage } from '../../lib/errors';
import { preferencesOf } from '../../lib/preferences';
import { CURRENT_USER_KEY } from '../../lib/queryKeys';
import type { Theme } from '../../lib/theme';
import type {
  FontSize,
  HomeView,
  NameDisplay,
  UserPreferencesUpdate,
  WeekStart,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
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
            detail="Saved in this browser, so each device can keep its own."
            value={theme}
            choices={THEME_CHOICES}
            onChange={setTheme}
          />
        </div>
      </div>
    </section>
  );
};

export default PreferencesSection;
