"use client";

import { isDesktopApp } from "@midday/desktop-client/platform";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@midday/ui/card";
import { Switch } from "@midday/ui/switch";
import { useEffect, useState } from "react";
import {
  desktopNotificationsEnabled,
  setDesktopNotificationsEnabled,
  showOnDesktop,
} from "@/utils/desktop-notifications";

// Only the desktop app renders this. The setting lives in this device's
// storage, so it is read after mount, never on the server.
export function DesktopNotificationSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    if (isDesktopApp()) {
      setEnabled(desktopNotificationsEnabled());
    }
  }, []);

  if (enabled === null) {
    return null;
  }

  const onCheckedChange = (on: boolean) => {
    setDesktopNotificationsEnabled(on);
    setEnabled(on);

    if (on) {
      // The first notification is when the operating system asks whether
      // this app may show them, so it asks now rather than at launch.
      showOnDesktop("Desktop notifications are on", "/settings/notifications", {
        evenInForeground: true,
      });
    }
  };

  return (
    <Card className="flex justify-between items-center">
      <CardHeader>
        <CardTitle>Desktop Notifications</CardTitle>
        <CardDescription>
          Show new notifications on this computer while the app is running, also
          from the tray.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <Switch checked={enabled} onCheckedChange={onCheckedChange} />
      </CardContent>
    </Card>
  );
}
