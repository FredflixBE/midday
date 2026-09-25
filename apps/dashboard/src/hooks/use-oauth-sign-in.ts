"use client";

import { isDesktopApp } from "@midday/desktop-client/platform";
import { createClient } from "@midday/supabase/client";
import type { Provider } from "@supabase/supabase-js";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { getUrl } from "@/utils/environment";

/**
 * Google is the only way in: the OAuth client is an internal Workspace app, and
 * no other provider is enabled in Supabase (FF-1427, FF-1435). Adding one means
 * enabling it there and adding it here.
 */
export type OAuthProvider = "google";

type ProviderConfig = {
  name: string;
  queryParams?: Record<string, string>;
  supportsReturnTo: boolean;
};

const OAUTH_PROVIDERS: Record<OAuthProvider, ProviderConfig> = {
  google: {
    name: "Google",
    queryParams: { prompt: "select_account" },
    supportsReturnTo: true,
  },
};

export function useOAuthSignIn(provider: OAuthProvider) {
  const [isLoading, setLoading] = useState(false);
  const supabase = createClient();
  const searchParams = useSearchParams();
  const returnTo = searchParams.get("return_to");
  const config = OAUTH_PROVIDERS[provider];

  const handleSignIn = async () => {
    setLoading(true);

    const redirectTo = new URL("/api/auth/callback", getUrl());

    const isDesktop = isDesktopApp();

    if (isDesktop) {
      redirectTo.searchParams.append("client", "desktop");
    } else if (config.supportsReturnTo && returnTo) {
      redirectTo.searchParams.append("return_to", returnTo);
    }

    const queryParams = isDesktop
      ? { ...config.queryParams, client: "desktop" }
      : config.queryParams;

    await supabase.auth.signInWithOAuth({
      provider: provider as Provider,
      options: {
        redirectTo: redirectTo.toString(),
        queryParams,
      },
    });

    setTimeout(() => {
      setLoading(false);
    }, 2000);
  };

  return { handleSignIn, isLoading, config };
}
