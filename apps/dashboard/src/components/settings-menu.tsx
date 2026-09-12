"use client";

import { useQuery } from "@tanstack/react-query";
import { SecondaryMenu } from "@/components/secondary-menu";
import { useTRPC } from "@/trpc/client";

const ITEMS = [
  { path: "/settings", label: "General" },
  { path: "/settings/accounts", label: "Bank Connections" },
  { path: "/settings/members", label: "Members" },
  { path: "/settings/notifications", label: "Notifications" },
  { path: "/settings/developer", label: "Developer" },
];

/**
 * The settings tabs, with Admin added for whoever the installation calls its
 * developer.
 *
 * Hiding the tab is a courtesy, not the guard — the mutations behind it are
 * closed to everyone else regardless, and the page itself checks again before
 * it renders.
 */
export function SettingsMenu() {
  const trpc = useTRPC();
  const { data: isDeveloper } = useQuery(trpc.admin.isDeveloper.queryOptions());

  return (
    <SecondaryMenu
      items={
        isDeveloper
          ? [...ITEMS, { path: "/settings/admin", label: "Admin" }]
          : ITEMS
      }
    />
  );
}
