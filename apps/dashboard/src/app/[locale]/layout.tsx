import "@/styles/globals.css";
import { cn } from "@midday/ui/cn";
import { Toaster } from "@midday/ui/toaster";
import type { Metadata } from "next";
import { Geist, Outfit } from "next/font/google";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import type { ReactElement } from "react";
import { isDesktopApp } from "@/utils/desktop";
import { getUrl } from "@/utils/environment";
import { Providers } from "./providers";

export const metadata: Metadata = {
  metadataBase: new URL(getUrl()),
  title: "Midday | Run your business smarter",
  description:
    "Automate financial tasks, stay organized, and make informed decisions effortlessly.",
  // No social preview images: this dashboard sits behind a login, and the
  // ones here were JPEGs on Midday's CDN. Everything else resolves against
  // metadataBase above.
  twitter: {
    title: "Midday | Run your business smarter",
    description:
      "Automate financial tasks, stay organized, and make informed decisions effortlessly.",
  },
  openGraph: {
    title: "Midday | Run your business smarter",
    description:
      "Automate financial tasks, stay organized, and make informed decisions effortlessly.",
    siteName: "Midday",
    locale: "en_US",
    type: "website",
  },
};

// The preset's faces (FF-1774): Geist for text, Outfit for headings. The
// theme reads both variables; `font-serif` is the heading face too.
const geist = Geist({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const outfit = Outfit({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-heading",
});

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: [
    { media: "(prefers-color-scheme: light)" },
    { media: "(prefers-color-scheme: dark)" },
  ],
};

export default async function Layout({
  children,
  params,
}: {
  children: ReactElement;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const isDesktop = await isDesktopApp();

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={cn(geist.variable, outfit.variable, isDesktop && "desktop")}
    >
      <body
        className={cn(
          "font-sans",
          "whitespace-pre-line overscroll-none antialiased",
        )}
      >
        <NuqsAdapter>
          <Providers locale={locale} isDesktop={Boolean(isDesktop)}>
            {children}
            <Toaster />
          </Providers>
        </NuqsAdapter>
      </body>
    </html>
  );
}
