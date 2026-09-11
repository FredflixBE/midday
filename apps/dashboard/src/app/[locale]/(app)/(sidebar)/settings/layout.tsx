import { SettingsMenu } from "@/components/settings-menu";
import { HydrateClient, prefetch, trpc } from "@/trpc/server";

export default function Layout({ children }: { children: React.ReactNode }) {
  // Prefetched so the Admin tab is there on first paint rather than appearing
  // a moment later.
  prefetch(trpc.admin.isDeveloper.queryOptions());

  return (
    <HydrateClient>
      <div className="max-w-[800px]">
        <SettingsMenu />

        <main className="mt-8">{children}</main>
      </div>
    </HydrateClient>
  );
}
