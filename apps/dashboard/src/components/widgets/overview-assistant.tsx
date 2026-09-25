"use client";

import { Button } from "@midday/ui/button";
import { Icons } from "@midday/ui/icons";
import dynamic from "next/dynamic";
import { parseAsBoolean, useQueryState } from "nuqs";
import { useCallback } from "react";
import { createPortal } from "react-dom";
import { ChatProvider } from "@/components/chat/chat-context";
import { ChatTitle } from "@/components/chat/chat-title";
import { NewChatButton } from "@/components/chat/new-chat-button";
import { useInvoiceParams } from "@/hooks/use-invoice-params";
import { AskMidday } from "./ask-midday";
import { QuickActions } from "./quick-actions";

// The conversation, its markdown renderer and the invoice canvas load when
// the chat opens, not with the Ask bar.
const ChatView = dynamic(
  () => import("@/components/chat/chat-view").then((m) => m.ChatView),
  { ssr: false },
);

/**
 * The overview's assistant: one chat state shared by the Ask bar, which it
 * renders into `askSlot` on the overview, and the chat view that replaces the
 * overview once a conversation starts.
 */
export function OverviewAssistant({
  isChat,
  askSlot,
}: {
  isChat: boolean;
  askSlot: HTMLDivElement | null;
}) {
  const [, setAssistant] = useQueryState("assistant", parseAsBoolean);
  const { setParams: setInvoiceParams } = useInvoiceParams();

  const openChat = useCallback(() => {
    setAssistant(true);
  }, [setAssistant]);

  const goBack = useCallback(() => {
    setInvoiceParams(null);
    setAssistant(null);
  }, [setInvoiceParams, setAssistant]);

  return (
    <ChatProvider>
      {isChat && (
        <div>
          <ChatView
            header={
              <>
                <Button variant="outline" size="icon" onClick={goBack}>
                  <Icons.ArrowBack className="size-4" />
                </Button>
                <ChatTitle />
                <NewChatButton variant="outline" />
              </>
            }
          />
        </div>
      )}

      {!isChat &&
        askSlot &&
        createPortal(
          <>
            <AskMidday onChatOpen={openChat} />
            <QuickActions onChatOpen={openChat} />
          </>,
          askSlot,
        )}
    </ChatProvider>
  );
}
