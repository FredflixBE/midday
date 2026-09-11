"use client";

import { Icons } from "@midday/ui/icons";
import { SubmitButton } from "@midday/ui/submit-button";
import { useToast } from "@midday/ui/use-toast";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTRPC } from "@/trpc/client";

type Props = {
  redirectPath?: string;
  /** The date the first sync reads from (YYYY-MM-DD). */
  since?: string;
};

export function ConnectOutlook({ redirectPath, since }: Props) {
  const trpc = useTRPC();
  const router = useRouter();
  const { toast } = useToast();

  const connectMutation = useMutation(
    trpc.inboxAccounts.connect.mutationOptions({
      onSuccess: (authUrl) => {
        if (authUrl) {
          router.push(authUrl);
        }
      },
      // A start date the server refuses says why.
      onError: (error) => {
        toast({
          duration: 5000,
          variant: "error",
          title: "Could not connect Outlook",
          description: error.message,
        });
      },
    }),
  );

  return (
    <SubmitButton
      className="px-4 font-medium h-[40px] w-full"
      variant="outline"
      data-track="Inbox Email Connected"
      data-provider="outlook"
      onClick={() =>
        connectMutation.mutate({ provider: "outlook", redirectPath, since })
      }
      isSubmitting={connectMutation.isPending}
    >
      <div className="flex items-center space-x-2">
        <Icons.Outlook />
        <span>Connect Outlook</span>
      </div>
    </SubmitButton>
  );
}
