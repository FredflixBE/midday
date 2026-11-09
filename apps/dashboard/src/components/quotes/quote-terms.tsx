"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import { QUOTE_TYPESET } from "@midday/invoice/templates/typeset";
import { Button } from "@midday/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@midday/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@midday/ui/dialog";
import { Editor } from "@midday/ui/editor";
import { Input } from "@midday/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@midday/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@midday/ui/table";
import { formatDate } from "@midday/utils/format";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { type CSSProperties, useState } from "react";
import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";
import { useErrorToast } from "./use-error-toast";

const LANGUAGES = { nl: "Dutch", en: "English" };

type Terms = RouterOutputs["quotes"]["terms"][number];
type Doc = { type: "doc"; content: Record<string, unknown>[] };

const EMPTY: Doc = { type: "doc", content: [] };
const ONE_PARAGRAPH: Doc = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

/** The terms are set as the quote sets its own text (FF-1663, FF-1674). */
const TYPESET_VARS = {
  "--typeset-size": "14px",
  "--typeset-leading": `${QUOTE_TYPESET.leading.body}`,
  "--typeset-flow": `${QUOTE_TYPESET.flow.paragraph}em`,
} as CSSProperties;

/**
 * Settings → Quotes, general terms (FF-1616, rewritten by FF-1674).
 *
 * Terms only bind if the client could know them before the contract was
 * concluded, so each version is kept whole and a quote records the one it
 * went out with. They are written here rather than uploaded: the quote PDF
 * prints them as its closing annex, in the quote's own typeset.
 *
 * A version a quote has gone out with can no longer be changed — rewriting
 * it would alter, after the fact, what that client could have known. It
 * opens read-only, and a new version is the way forward.
 */
export function QuoteTerms() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorToast = useErrorToast();
  const { data: user } = useUserQuery();
  const { data: terms } = useSuspenseQuery(trpc.quotes.terms.queryOptions());

  const [editing, setEditing] = useState<Terms | "new" | null>(null);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: trpc.quotes.terms.queryKey() });

  const remove = useMutation(
    trpc.quotes.deleteTerms.mutationOptions({
      onSuccess: () => refresh(),
      onError: errorToast("Not removed"),
    }),
  );

  const fileUrl = (path: string[]) =>
    `${process.env.NEXT_PUBLIC_API_URL}/files/download/file?path=${encodeURIComponent(path.join("/"))}&fk=${user?.fileKey}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>General terms</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {terms.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>Language</TableHead>
                <TableHead>Added</TableHead>
                <TableHead className="w-[160px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {terms.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{row.label}</TableCell>
                  <TableCell>
                    {LANGUAGES[row.language as keyof typeof LANGUAGES] ??
                      row.language}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {formatDate(row.createdAt.slice(0, 10), user?.dateFormat)}
                  </TableCell>
                  <TableCell className="py-0 text-right">
                    {/* Uploaded under FF-1616: there is no text to open, so
                        the file itself is what this row offers. */}
                    {row.filePath && !row.content ? (
                      user?.fileKey ? (
                        <a
                          className="text-sm underline"
                          target="_blank"
                          rel="noreferrer"
                          href={fileUrl(row.filePath)}
                        >
                          {row.fileName}
                        </a>
                      ) : (
                        <span className="text-sm">{row.fileName}</span>
                      )
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditing(row)}
                      >
                        {row.inUse ? "Read" : "Edit"}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={remove.isPending || row.inUse}
                      onClick={() => remove.mutate({ id: row.id })}
                    >
                      Remove
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}

        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => setEditing("new")}
          >
            Add version
          </Button>
        </div>
      </CardContent>

      {editing ? (
        <TermsDialog
          terms={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await refresh();
            setEditing(null);
          }}
        />
      ) : null}
    </Card>
  );
}

function TermsDialog({
  terms,
  onClose,
  onSaved,
}: {
  /** Null for a version that does not exist yet. */
  terms: Terms | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const trpc = useTRPC();
  const errorToast = useErrorToast();

  const [label, setLabel] = useState(terms?.label ?? "");
  const [language, setLanguage] = useState<"nl" | "en">(
    (terms?.language as "nl" | "en") ?? "nl",
  );
  const [content, setContent] = useState<Doc>(
    (terms?.content as Doc | null) ?? EMPTY,
  );

  const frozen = Boolean(terms?.inUse);

  const add = useMutation(
    trpc.quotes.addTerms.mutationOptions({
      onSuccess: () => onSaved(),
      onError: errorToast("Not added"),
    }),
  );

  const update = useMutation(
    trpc.quotes.updateTerms.mutationOptions({
      onSuccess: () => onSaved(),
      onError: errorToast("Not saved"),
    }),
  );

  const saving = add.isPending || update.isPending;

  const save = () => {
    if (terms) {
      update.mutate({ id: terms.id, content });
    } else {
      add.mutate({ label, language, content });
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-4xl">
        <div className="space-y-6 p-4">
          <DialogHeader>
            <DialogTitle>
              {terms ? `General terms ${terms.label}` : "New version"}
            </DialogTitle>
            <DialogDescription>
              {frozen
                ? "A quote has gone out with this version, so it can no longer be changed. Add a new version instead."
                : "Printed at the end of every quote sent in this language."}
            </DialogDescription>
          </DialogHeader>

          {terms ? null : (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2 text-sm">
                <label htmlFor="terms-label" className="text-muted-foreground">
                  Version
                </label>
                <Input
                  id="terms-label"
                  value={label}
                  maxLength={50}
                  placeholder="2026-01"
                  onChange={(event) => setLabel(event.target.value)}
                />
              </div>
              <div className="space-y-2 text-sm">
                <label
                  htmlFor="terms-language"
                  className="text-muted-foreground"
                >
                  Language
                </label>
                <Select
                  value={language}
                  onValueChange={(next) => setLanguage(next as "nl" | "en")}
                >
                  <SelectTrigger id="terms-language">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(LANGUAGES) as (keyof typeof LANGUAGES)[]).map(
                      (key) => (
                        <SelectItem key={key} value={key}>
                          {LANGUAGES[key]}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <Editor
            initialContent={content.content.length ? content : ONE_PARAGRAPH}
            editable={!frozen}
            slashMenu={!frozen}
            toolbar={!frozen}
            placeholder="Type '/' for commands"
            className="typeset typeset-quote max-h-[50vh] min-h-[16rem] overflow-y-auto border border-border p-4"
            style={TYPESET_VARS}
            onUpdate={(editor) =>
              setContent((editor.isEmpty ? EMPTY : editor.getJSON()) as Doc)
            }
          />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {frozen ? "Close" : "Cancel"}
            </Button>
            {frozen ? null : (
              <Button
                type="button"
                onClick={save}
                disabled={
                  saving || !label.trim() || content.content.length === 0
                }
              >
                Save
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
