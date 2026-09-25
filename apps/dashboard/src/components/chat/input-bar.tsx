"use client";

import type { ConnectedApp } from "@/components/chat/chat-context";
import { ChatInput } from "@/components/chat/chat-input";

/**
 * The assistant's input, shared by the overview's Ask bar and the chat view.
 * Its own module so the Ask bar does not pull in the chat view, and with it
 * the markdown renderer and the invoice canvas (FF-1712).
 */
export function InputBar({
  isActive,
  hasMessages,
  inputValue,
  isStreaming,
  onChange,
  onSubmit,
  onStop,
  onEscape,
  onSuggestion,
  menuPosition,
  connectedApps,
  mentionedApps,
  onMentionApp,
  onRemoveMention,
}: {
  isActive?: boolean;
  hasMessages?: boolean;
  inputValue: string;
  isStreaming: boolean;
  onChange: (v: string) => void;
  onSubmit: (files?: File[]) => void;
  onStop: () => void;
  onEscape?: () => void;
  onSuggestion?: (text: string) => void;
  menuPosition?: "above" | "below";
  connectedApps?: ConnectedApp[];
  mentionedApps?: ConnectedApp[];
  onMentionApp?: (app: ConnectedApp) => void;
  onRemoveMention?: (slug: string) => void;
}) {
  return (
    <div className="bg-[rgba(247,247,247,0.85)] dark:bg-[rgba(19,19,19,0.7)] backdrop-blur-lg">
      <ChatInput
        value={inputValue}
        onChange={onChange}
        onSubmit={onSubmit}
        onStop={onStop}
        isStreaming={isStreaming}
        placeholder={hasMessages ? "Reply..." : "How can I help you today?"}
        autoFocus={isActive}
        onEscape={onEscape}
        onSuggestion={onSuggestion}
        menuPosition={menuPosition}
        connectedApps={connectedApps}
        mentionedApps={mentionedApps}
        onMentionApp={onMentionApp}
        onRemoveMention={onRemoveMention}
      />
    </div>
  );
}
