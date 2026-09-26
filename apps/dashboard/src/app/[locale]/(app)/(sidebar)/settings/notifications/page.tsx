import type { Metadata } from "next";
import { Suspense } from "react";
import { DesktopNotificationSettings } from "@/components/desktop-notification-settings";
import { NotificationsSettingsList } from "@/components/notifications-settings-list";

export const metadata: Metadata = {
  title: "Notifications | Midday",
};

export default async function Notifications() {
  return (
    <div className="space-y-12">
      <DesktopNotificationSettings />
      <Suspense>
        <NotificationsSettingsList />
      </Suspense>
    </div>
  );
}
