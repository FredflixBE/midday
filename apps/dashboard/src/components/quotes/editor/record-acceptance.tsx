"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import { optionalLinesOf, type QuoteContent } from "@midday/quote";
import { Button } from "@midday/ui/button";
import { Checkbox } from "@midday/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
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
import { useToast } from "@midday/ui/use-toast";
import { formatDate } from "@midday/utils/format";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";
import { uploadToQuotes } from "../upload-to-quotes";
import { useErrorToast } from "../use-error-toast";
import { DateField, Field, isoDate, ReadOnlyContext } from "./fields";
import { useRefreshQuote } from "./quote-actions";

type Quote = RouterOutputs["quotes"]["get"];
type Version = Quote["versions"][number];

/** Big enough for a scan of a signed order form. */
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * Recording that the client said yes (FF-1615). In v1 the answer arrives
 * outside Midday — an email, an order form, a PO — so this is where it is
 * written down: which scenario was taken, which optional items came along,
 * who answered and when, and the document that says so.
 *
 * Opening it on a version that was already accepted shows what was recorded,
 * so a mistyped PO or the wrong scenario can be put right; a won quote keeps
 * its outcome otherwise.
 */
export function RecordAcceptance({
  quoteId,
  version,
}: {
  quoteId: string;
  version: Version;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        {version.status === "accepted" ? "Acceptance" : "Record acceptance"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[460px]">
          {/* Fresh fields every time it opens, and the read-only rule of a
              sent version does not reach inside this form. */}
          {open ? (
            <ReadOnlyContext.Provider value={false}>
              <AcceptanceForm
                key={version.id}
                quoteId={quoteId}
                version={version}
                done={() => setOpen(false)}
              />
            </ReadOnlyContext.Provider>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function AcceptanceForm({
  quoteId,
  version,
  done,
}: {
  quoteId: string;
  version: Version;
  done: () => void;
}) {
  const trpc = useTRPC();
  const { toast } = useToast();
  const { data: user } = useUserQuery();
  const errorToast = useErrorToast();
  const refresh = useRefreshQuote(quoteId);

  const scenarios = (version.content as QuoteContent).scenarios;
  const suggested =
    scenarios.find((scenario) => scenario.recommended) ?? scenarios[0];

  const [scenarioId, setScenarioId] = useState(
    version.acceptedScenarioId ?? suggested?.id ?? "",
  );
  const [taken, setTaken] = useState<string[]>(
    version.acceptedOptionalLineIds ?? [],
  );
  const [acceptedAt, setAcceptedAt] = useState(
    version.acceptedAt?.slice(0, 10) ?? isoDate(new Date()),
  );
  const [name, setName] = useState(version.acceptedByName ?? "");
  const [poNumber, setPoNumber] = useState(version.poNumber ?? "");
  const [filePath, setFilePath] = useState<string[] | null>(
    version.acceptanceFilePath ?? null,
  );
  const [uploading, setUploading] = useState(false);

  const chosen = scenarios.find((scenario) => scenario.id === scenarioId);
  const optional = chosen ? optionalLinesOf(chosen) : [];

  const accept = useMutation(
    trpc.quotes.accept.mutationOptions({
      onSuccess: async () => {
        await refresh();
        done();
      },
      onError: errorToast("Not recorded"),
    }),
  );

  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (!user?.teamId) return;
    if (file.size > MAX_BYTES) {
      toast({ variant: "error", title: "That document is over 20 MB." });
      return;
    }

    setUploading(true);
    try {
      setFilePath(await uploadToQuotes(user.teamId, file));
    } catch {
      toast({ variant: "error", title: "That document was not stored." });
    } finally {
      setUploading(false);
    }
  };

  return (
    <form
      className="space-y-6 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        accept.mutate({
          versionId: version.id,
          scenarioId,
          optionalLineIds: taken,
          acceptedAt,
          acceptedByName: name.trim() || null,
          poNumber: poNumber.trim() || null,
          acceptanceFilePath: filePath,
        });
      }}
    >
      <DialogHeader>
        <DialogTitle>Record acceptance</DialogTitle>
      </DialogHeader>

      <Field label="Scenario">
        <Select
          value={scenarioId}
          onValueChange={(next) => {
            setScenarioId(next);
            // The optional items belong to one scenario; another's are not
            // what was taken.
            setTaken([]);
          }}
        >
          <SelectTrigger aria-label="Scenario">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {scenarios.map((scenario) => (
              <SelectItem key={scenario.id} value={scenario.id}>
                {scenario.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {optional.length > 0 ? (
        <Field label="Optional items taken">
          <div className="space-y-2">
            {optional.map((line) => (
              <div key={line.id} className="flex items-center gap-2">
                <Checkbox
                  id={`optional-${line.id}`}
                  checked={taken.includes(line.id)}
                  onCheckedChange={(checked) =>
                    setTaken((current) =>
                      checked
                        ? [...current, line.id]
                        : current.filter((id) => id !== line.id),
                    )
                  }
                />
                <Label
                  htmlFor={`optional-${line.id}`}
                  className="text-sm font-normal"
                >
                  {line.title}
                </Label>
              </div>
            ))}
          </div>
        </Field>
      ) : null}

      <div className="grid grid-cols-2 gap-4">
        <Field label="Accepted on">
          <DateField
            aria-label="Accepted on"
            value={acceptedAt}
            onChange={setAcceptedAt}
          />
        </Field>
        <Field label="PO number">
          <Input
            aria-label="PO number"
            value={poNumber}
            maxLength={100}
            onChange={(event) => setPoNumber(event.target.value)}
          />
        </Field>
      </div>

      <Field label="Accepted by">
        <Input
          aria-label="Accepted by"
          value={name}
          maxLength={300}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>

      <Field label="Document">
        <div className="flex items-center gap-3">
          <Input
            type="file"
            aria-label="Document"
            className="file:mr-3 file:border-0 file:bg-transparent file:text-sm"
            disabled={uploading}
            onChange={(event) => void pick(event.target.files?.[0])}
          />
          {filePath ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setFilePath(null)}
            >
              Remove
            </Button>
          ) : null}
        </div>
      </Field>

      <DialogFooter>
        <Button
          type="submit"
          disabled={!scenarioId || uploading || accept.isPending}
        >
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * What was recorded, in one line beside the state (FF-1615): who answered,
 * when, the PO number, and the document that says so.
 */
export function AcceptanceNote({ version }: { version: Version }) {
  const { data: user } = useUserQuery();

  if (!version.acceptedAt) return null;

  const said = [
    version.acceptedByName
      ? `Accepted by ${version.acceptedByName}`
      : "Accepted",
    formatDate(version.acceptedAt.slice(0, 10), user?.dateFormat),
    version.poNumber ? `PO ${version.poNumber}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const path = version.acceptanceFilePath?.join("/");

  return (
    <span className="truncate text-sm text-[#878787]">
      {said}
      {path && user?.fileKey ? (
        <>
          {" · "}
          <a
            className="underline"
            target="_blank"
            rel="noreferrer"
            href={`${process.env.NEXT_PUBLIC_API_URL}/files/download/file?path=${encodeURIComponent(path)}&fk=${user.fileKey}`}
          >
            Document
          </a>
        </>
      ) : null}
    </span>
  );
}
