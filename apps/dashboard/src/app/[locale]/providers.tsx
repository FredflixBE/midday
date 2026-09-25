"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { I18nProviderClient } from "@/locales/client";
import { TRPCReactProvider } from "@/trpc/client";

// Only the desktop app renders these, so web pages never load the Tauri window
// and event APIs they import (FF-1725). They are here rather than in the root
// layout because Next downloads every client component a layout imports,
// rendered or not.
const DesktopHeader = dynamic(
  () => import("@/components/desktop-header").then((mod) => mod.DesktopHeader),
  { ssr: false },
);
const DesktopProvider = dynamic(
  () =>
    import("@/components/desktop-provider").then((mod) => mod.DesktopProvider),
  { ssr: false },
);

type ProviderProps = {
  locale: string;
  /** Worked out from the user agent by the root layout. */
  isDesktop: boolean;
  children: ReactNode;
};

export function Providers({ locale, isDesktop, children }: ProviderProps) {
  return (
    <TRPCReactProvider>
      <I18nProviderClient locale={locale}>
        {isDesktop && (
          <>
            <DesktopHeader />
            <DesktopProvider />
          </>
        )}

        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </I18nProviderClient>
    </TRPCReactProvider>
  );
}
