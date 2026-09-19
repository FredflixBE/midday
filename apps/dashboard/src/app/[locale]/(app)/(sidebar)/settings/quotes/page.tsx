import type { Metadata } from "next";
import { WorkTypesSettings } from "@/components/quotes/work-types-settings";
import { HydrateClient, prefetch, trpc } from "@/trpc/server";

export const metadata: Metadata = {
  title: "Quotes | Midday",
};

export default async function Page() {
  prefetch(trpc.workTypes.list.queryOptions({ includeArchived: true }));

  return (
    <HydrateClient>
      <div className="space-y-12">
        <WorkTypesSettings />
      </div>
    </HydrateClient>
  );
}
