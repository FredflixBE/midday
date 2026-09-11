"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@midday/ui/dialog";
import { Input } from "@midday/ui/input";
import { Label } from "@midday/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@midday/ui/select";
import { SubmitButton } from "@midday/ui/submit-button";
import { useToast } from "@midday/ui/use-toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/trpc/client";

type Region = "be" | "nl";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Connects Yuki to the current team with an access key. The key is checked
 * with Yuki first, read-only, and the administration it reads is shown so the
 * user can confirm the company before anything is saved.
 */
export function YukiConnectModal({ open, onOpenChange }: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [accessKey, setAccessKey] = useState("");
  const [region, setRegion] = useState<Region>("be");
  const [administrationId, setAdministrationId] = useState<string>();

  const verify = useMutation(
    trpc.apps.verifyYuki.mutationOptions({
      // With several administrations the user picks one; nothing is chosen
      // for them, since Connect would otherwise take the first on one click.
      onSuccess: ({ administrations }) => {
        setAdministrationId(
          administrations.length === 1 ? administrations[0]?.id : undefined,
        );
      },
    }),
  );

  const connect = useMutation(
    trpc.apps.connectYuki.mutationOptions({
      onSuccess: ({ administrationName }) => {
        queryClient.invalidateQueries({ queryKey: trpc.apps.get.queryKey() });
        toast({
          title: "Yuki connected",
          description: `This team now reads the books of ${administrationName}.`,
          variant: "success",
        });
        close();
      },
    }),
  );

  const administrations = verify.data?.administrations;
  const chosen = administrations?.find((a) => a.id === administrationId);
  const error = verify.error ?? connect.error;

  // The confirmation must always describe what is typed in, so editing the
  // key or the region sends the user back to the check.
  function edited() {
    verify.reset();
    connect.reset();
    setAdministrationId(undefined);
  }

  function close() {
    setAccessKey("");
    setRegion("be");
    edited();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : close())}>
      <DialogContent className="max-w-[455px]">
        <div className="p-4 space-y-4">
          <DialogHeader>
            <DialogTitle>Connect Yuki</DialogTitle>
            <DialogDescription>
              Create an access key in Yuki under Settings &gt; Web services.
              Only this team will read these books.
            </DialogDescription>
          </DialogHeader>

          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (chosen) {
                connect.mutate({
                  accessKey,
                  region,
                  administrationId: chosen.id,
                });
              } else {
                verify.mutate({ accessKey, region });
              }
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="yuki-access-key">Access key</Label>
              <Input
                id="yuki-access-key"
                type="password"
                autoFocus
                autoComplete="off"
                spellCheck="false"
                value={accessKey}
                onChange={(event) => {
                  setAccessKey(event.target.value);
                  edited();
                }}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="yuki-region">Region</Label>
              <Select
                value={region}
                onValueChange={(value) => {
                  setRegion(value as Region);
                  edited();
                }}
              >
                <SelectTrigger id="yuki-region">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="be">Belgium</SelectItem>
                  <SelectItem value="nl">Netherlands</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {administrations && (
              <div className="space-y-2">
                <Label htmlFor="yuki-administration">Administration</Label>
                {administrations.length === 1 && chosen ? (
                  <p id="yuki-administration" className="text-sm">
                    {chosen.name}
                    {chosen.vatNumber && (
                      <span className="text-[#878787]">
                        {" "}
                        · {chosen.vatNumber}
                      </span>
                    )}
                  </p>
                ) : (
                  <Select
                    value={administrationId}
                    onValueChange={setAdministrationId}
                  >
                    <SelectTrigger id="yuki-administration">
                      <SelectValue placeholder="Choose the company" />
                    </SelectTrigger>
                    <SelectContent>
                      {administrations.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name}
                          {a.vatNumber ? ` · ${a.vatNumber}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}

            {error && <p className="text-sm text-red-500">{error.message}</p>}

            <SubmitButton
              type="submit"
              className="w-full"
              disabled={!accessKey.trim() || (!!administrations && !chosen)}
              isSubmitting={verify.isPending || connect.isPending}
            >
              {chosen ? `Connect ${chosen.name}` : "Check key"}
            </SubmitButton>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
