import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MaintenanceActions } from "@/components/admin/maintenance-actions";
import { getTRPCClient } from "@/trpc/server";

export const metadata: Metadata = {
  title: "Admin | Midday",
};

/**
 * Whether to render this page at all.
 *
 * A request that cannot be answered counts as no, so a failing API shows the
 * same 404 as a team member who guessed the URL rather than a page of buttons
 * that would only refuse them.
 */
async function callerIsDeveloper(): Promise<boolean> {
  try {
    const client = await getTRPCClient();

    return await client.admin.isDeveloper.query();
  } catch {
    return false;
  }
}

export default async function Page() {
  // Reaching the URL is not the same as being allowed to use it. The mutations
  // behind this page are closed to everyone but the developer regardless; this
  // is so the page matches.
  if (!(await callerIsDeveloper())) {
    notFound();
  }

  return <MaintenanceActions />;
}
