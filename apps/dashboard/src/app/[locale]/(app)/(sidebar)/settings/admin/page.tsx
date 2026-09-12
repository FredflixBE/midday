import type { Metadata } from "next";
import { MaintenanceActions } from "@/components/admin/maintenance-actions";

export const metadata: Metadata = {
  title: "Admin | Midday",
};

export default function Page() {
  return <MaintenanceActions />;
}
