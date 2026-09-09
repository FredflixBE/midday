"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@midday/ui/dropdown-menu";
import { Icons } from "@midday/ui/icons";
import { ScrollArea } from "@midday/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader } from "@midday/ui/sheet";
import { useToast } from "@midday/ui/use-toast";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useCopyToClipboard } from "usehooks-ts";
import { OAuthApplicationForm } from "@/components/forms/oauth-application-form";
import { DeleteOAuthApplicationModal } from "@/components/modals/delete-oauth-application-modal";
import { OAuthApplicationStatusBadge } from "@/components/oauth-application-status-badge";
import { useOAuthApplicationParams } from "@/hooks/use-oauth-application-params";
import { useTRPC } from "@/trpc/client";

export function OAuthApplicationEditSheet() {
  const trpc = useTRPC();
  const { toast } = useToast();
  const [, copy] = useCopyToClipboard();
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const { setParams, applicationId, editApplication } =
    useOAuthApplicationParams();

  const isOpen = Boolean(applicationId && editApplication);

  const { data: application } = useQuery(
    trpc.oauthApplications.get.queryOptions(
      { id: applicationId! },
      {
        enabled: isOpen,
      },
    ),
  );

  const handleCopyClientId = () => {
    if (application?.clientId) {
      copy(application.clientId);
      toast({
        title: "Client ID copied to clipboard",
        variant: "success",
      });
    }
  };

  return (
    <Sheet open={isOpen} onOpenChange={() => setParams(null)}>
      <SheetContent stack>
        <SheetHeader className="mb-6 flex justify-between items-center flex-row">
          <h2 className="text-xl">Edit OAuth Application</h2>

          <div className="flex items-center gap-2">
            {application?.status && (
              <OAuthApplicationStatusBadge status={application.status} />
            )}

            {applicationId && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button">
                    <Icons.MoreVertical className="size-5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent sideOffset={10} align="end">
                  <DropdownMenuItem onClick={handleCopyClientId}>
                    Copy Client ID
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={() => setShowDeleteModal(true)}
                  >
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </SheetHeader>

        <ScrollArea className="h-full p-0 pb-10" hideScrollbar>
          <OAuthApplicationForm data={application} key={application?.id} />
        </ScrollArea>
      </SheetContent>

      <DeleteOAuthApplicationModal
        applicationId={applicationId!}
        applicationName={application?.name || ""}
        isOpen={showDeleteModal}
        onOpenChange={setShowDeleteModal}
      />
    </Sheet>
  );
}
