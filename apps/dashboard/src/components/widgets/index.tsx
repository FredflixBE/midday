"use client";

import dynamic from "next/dynamic";
import { parseAsBoolean, useQueryState } from "nuqs";
import { Suspense, useState } from "react";
import { useFeatureAvailability } from "@/hooks/use-feature-availability";
import { McpBanner } from "./mcp-banner";
import { SummarySkeleton, WidgetCardsSkeleton } from "./overview-skeleton";
import { WelcomeGreeting, WelcomeSummary } from "./welcome-section";
import { WidgetCards } from "./widget-cards";

// The assistant (chat state, the Ask bar, the chat view) is its own chunk,
// loaded only on an instance that offers it (FF-1712).
const OverviewAssistant = dynamic(
  () => import("./overview-assistant").then((m) => m.OverviewAssistant),
  { ssr: false },
);

export function OverviewView() {
  const [assistant] = useQueryState("assistant", parseAsBoolean);
  // Without an OpenAI key every chat request fails, so the assistant is not
  // offered at all on this instance.
  const { assistant: assistantAvailable } = useFeatureAvailability();
  // Where the Ask bar goes on the overview. The assistant renders it there
  // through a portal, so the overview below never remounts when the
  // assistant's code arrives, and the chat state survives opening the chat.
  const [askSlot, setAskSlot] = useState<HTMLDivElement | null>(null);

  const isChat = assistant === true && assistantAvailable;

  return (
    <>
      {assistantAvailable && (
        <OverviewAssistant isChat={isChat} askSlot={askSlot} />
      )}

      {!isChat && (
        <div className="mt-2 pb-16 flex flex-col justify-center min-h-[calc(100vh-120px)] max-w-3xl mx-auto w-full">
          <div className="flex flex-col items-center text-center pt-6 pb-10 w-full">
            <WelcomeGreeting />
            <Suspense fallback={<SummarySkeleton />}>
              <WelcomeSummary />
            </Suspense>
          </div>
          {assistantAvailable && <div ref={setAskSlot} className="w-full" />}
          <Suspense fallback={<WidgetCardsSkeleton />}>
            <WidgetCards />
          </Suspense>
          <McpBanner />
        </div>
      )}
    </>
  );
}
