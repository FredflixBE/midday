import { redirect } from "next/navigation";
import { ExportStatus } from "@/components/export-status";
import { GlobalTimerProvider } from "@/components/global-timer-provider";
import { Header } from "@/components/header";
import { GlobalSheetsProvider } from "@/components/sheets/global-sheets-provider";
import { Sidebar } from "@/components/sidebar";
import { TimezoneDetector } from "@/components/timezone-detector";
import {
  getQueryClient,
  HydrateClient,
  prefetchForLayout,
  trpc,
} from "@/trpc/server";

export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const queryClient = getQueryClient();

  // Sent by this layout's HydrateClient alone, because the header, the
  // sidebar and the global sheets render outside every page's boundary.
  const layoutQueries = prefetchForLayout([
    trpc.user.me.queryOptions(),
    trpc.team.current.queryOptions(),
    trpc.invoice.defaultSettings.queryOptions(),
    trpc.search.global.queryOptions({ searchTerm: "" }),
  ]);

  // Fetch the user – .catch → redirect so a transient API failure
  // (timeout, 5xx, expired session, etc.) doesn't crash the entire
  // layout and blank the page.
  const user = await queryClient
    .fetchQuery(trpc.user.me.queryOptions())
    .catch(() => redirect("/login"));

  if (!user) {
    redirect("/login");
  }

  if (!user.fullName || !user.teamId) {
    redirect("/onboarding");
  }

  return (
    <HydrateClient queries={layoutQueries}>
      <div className="relative">
        <Sidebar />

        <div className="md:ml-[70px] pb-4">
          <Header />
          <div className="px-4 md:px-8">{children}</div>
        </div>

        <ExportStatus />
        <GlobalSheetsProvider />
        <GlobalTimerProvider />
        <TimezoneDetector />
      </div>
    </HydrateClient>
  );
}
