"use client";

import { Icons } from "@midday/ui/icons";
import { SubmitButton } from "@midday/ui/submit-button";
import { type OAuthProvider, useOAuthSignIn } from "@/hooks/use-oauth-sign-in";

type Props = {
  provider: OAuthProvider;
};

export function OAuthSignIn({ provider }: Props) {
  const { handleSignIn, isLoading, config } = useOAuthSignIn(provider);

  return (
    <SubmitButton
      type="button"
      onClick={handleSignIn}
      isSubmitting={isLoading}
      className="w-full font-sans text-sm h-[40px] px-6 py-4 transition-colors disabled:opacity-50 bg-transparent border border-foreground dark:border-border text-foreground hover:bg-foreground/5 dark:hover:bg-border/10"
    >
      <div className="flex items-center justify-center gap-2">
        <Icons.Google size={16} />
        <span>Continue with {config.name}</span>
      </div>
    </SubmitButton>
  );
}
