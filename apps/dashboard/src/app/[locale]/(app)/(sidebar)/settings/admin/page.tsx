import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MaintenanceActions } from "@/components/admin/maintenance-actions";
import { getTRPCClient } from "@/trpc/server";

export const metadata: Metadata = {
  title: "Admin | Midday",
};

export default async function Page() {
  const client = await getTRPCClient();

  // Reaching the URL directly is not the same as being allowed to use it. The
  // mutations behind this page are closed to everyone but the developer
  // anyway; this keeps a member who guessed the path from being shown buttons
  // that would only refuse them.
  if (!(await client.admin.isDeveloper.query())) {
    notFound();
  }

  return <MaintenanceActions />;
}
