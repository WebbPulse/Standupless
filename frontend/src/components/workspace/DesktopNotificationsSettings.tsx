/**
 * The desktop notifications block of notification settings. It belongs to this
 * device rather than to the person: the browser holds the permission for the
 * site, and the switch beside it is kept in this browser only. Inside the
 * desktop app the block only says that the app notifies on its own.
 */

import React, { useState } from 'react';
import { Button } from '../ui/button';
import Checkbox from '../ui/checkbox';
import { isDesktopShell } from '../../lib/desktop';
import {
  desktopPermission,
  readDesktopNotificationsEnabled,
  requestDesktopPermission,
  writeDesktopNotificationsEnabled,
  type DesktopPermission,
} from '../../lib/desktopNotifications';

/** What each permission state is called in the block. */
const PERMISSION_LABEL: Record<DesktopPermission, string> = {
  default: 'Not asked yet',
  granted: 'Allowed',
  denied: 'Blocked',
  unsupported: 'Not supported',
};

/** Renders the desktop notifications block and keeps its switch on this device. */
const DesktopNotificationsSettings: React.FC = () => {
  const [permission, setPermission] =
    useState<DesktopPermission>(desktopPermission);
  const [enabled, setEnabled] = useState<boolean>(
    readDesktopNotificationsEnabled
  );
  const [asking, setAsking] = useState(false);

  const setOn = (on: boolean): void => {
    writeDesktopNotificationsEnabled(on);
    setEnabled(on);
  };

  const enable = (): void => {
    setAsking(true);
    void requestDesktopPermission()
      .then((answer) => {
        setPermission(answer);
        if (answer === 'granted') setOn(true);
      })
      .finally(() => {
        setAsking(false);
      });
  };

  if (isDesktopShell()) {
    return (
      <section
        aria-label="Desktop notifications"
        className="space-y-1 rounded-md border border-line p-3"
      >
        <h3 className="text-sm font-medium text-text">Desktop notifications</h3>
        <p className="text-xs text-text-faint">
          The desktop app shows a system notification for each new inbox item on
          its own.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label="Desktop notifications"
      className="space-y-2 rounded-md border border-line p-3"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-medium text-text">
            Desktop notifications
          </h3>
          <p className="text-xs text-text-faint">
            Shows a system notification for each new inbox item while
            Standupless is open in a tab you are not looking at. This setting is
            for this browser only.
          </p>
        </div>
        {permission === 'default' && (
          <Button
            size="sm"
            variant="secondary"
            disabled={asking}
            onClick={enable}
          >
            Enable
          </Button>
        )}
      </div>
      <p className="text-xs text-text-muted" data-testid="desktop-permission">
        Browser permission: {PERMISSION_LABEL[permission]}
      </p>
      {permission === 'granted' && (
        <Checkbox
          label="Show desktop notifications on this device"
          checked={enabled}
          onChange={(event) => {
            setOn(event.target.checked);
          }}
        />
      )}
      {permission === 'denied' && (
        <p className="text-xs text-text-faint">
          Your browser is blocking notifications from this site. To allow them,
          open the site settings from the icon at the left of the address bar,
          set Notifications to Allow, then reload this page.
        </p>
      )}
      {permission === 'unsupported' && (
        <p className="text-xs text-text-faint">
          This browser cannot show desktop notifications.
        </p>
      )}
    </section>
  );
};

export default DesktopNotificationsSettings;
