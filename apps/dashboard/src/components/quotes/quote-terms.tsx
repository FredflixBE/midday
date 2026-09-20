"use client";

import { createClient } from "@midday/supabase/client";
import { Button } from "@midday/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@midday/ui/card";
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
import { useToast } from "@midday/ui/use-toast";
import { formatDate } from "@midday/utils/format";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useState } from "react";
import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";
import { resumableUpload } from "@/utils/upload";
import { useErrorToast } from "./use-error-toast";

const LANGUAGES = { nl: "Dutch", en: "English" };

/**
 * Settings → Quotes, general terms (FF-1616). Terms only bind if the client
 * could know them before the contract was concluded, so each version is kept
 * as its own file and a quote records the one it went out with. The newest
 * version in the quote's language is what a quote is sent with.
 */
export function QuoteTerms() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const errorToast = useErrorToast();
  const { data: user } = useUserQuery();
  const { data: terms } = useSuspenseQuery(trpc.quotes.terms.queryOptions());

  const [label, setLabel] = useState("");
  const [language, setLanguage] = useState<"nl" | "en">("nl");
  const [file, setFile] = useState<{ path: string[]; name: string } | null>(
    null,
  );
  const [uploading, setUploading] = useState(false);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: trpc.quotes.terms.queryKey() });

  const add = useMutation(
    trpc.quotes.addTerms.mutationOptions({
      onSuccess: async () => {
        await refresh();
        setLabel("");
        setFile(null);
      },
      onError: errorToast("Not added"),
    }),
  );

  const remove = useMutation(
    trpc.quotes.deleteTerms.mutationOptions({
      onSuccess: () => refresh(),
      onError: errorToast("Not removed"),
    }),
  );

  const pick = async (chosen: File | undefined) => {
    if (!chosen || !user?.teamId) return;

    setUploading(true);
    try {
      // A name of its own: storage writes are upserts, and two files called
      // terms.pdf would otherwise replace one another.
      const extension = chosen.name.split(".").pop();
      const named = new File(
        [chosen],
        extension ? `${crypto.randomUUID()}.${extension}` : crypto.randomUUID(),
        { type: chosen.type },
      );
      const folder = [user.teamId, "quotes"];
      await resumableUpload(createClient(), {
        bucket: "vault",
        path: folder,
        file: named,
      });
      setFile({ path: [...folder, named.name], name: chosen.name });
    } catch {
      toast({ variant: "error", title: "That file was not stored." });
    } finally {
      setUploading(false);
    }
  };

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
                <TableHead>File</TableHead>
                <TableHead>Added</TableHead>
                <TableHead className="w-[80px]" />
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
                  <TableCell className="max-w-[240px] truncate">
                    {user?.fileKey ? (
                      <a
                        className="underline"
                        target="_blank"
                        rel="noreferrer"
                        href={fileUrl(row.filePath)}
                      >
                        {row.fileName}
                      </a>
                    ) : (
                      row.fileName
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {formatDate(row.createdAt.slice(0, 10), user?.dateFormat)}
                  </TableCell>
                  <TableCell className="py-0 text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={remove.isPending}
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

        <form
          className="grid grid-cols-4 items-end gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!file) return;
            add.mutate({
              label,
              language,
              filePath: file.path,
              fileName: file.name,
            });
          }}
        >
          <div className="space-y-2 text-sm">
            <label htmlFor="terms-label" className="text-[#606060]">
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
            <label htmlFor="terms-language" className="text-[#606060]">
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
          <div className="space-y-2 text-sm">
            <label htmlFor="terms-file" className="text-[#606060]">
              File
            </label>
            <Input
              id="terms-file"
              type="file"
              accept="application/pdf"
              className="file:mr-3 file:border-0 file:bg-transparent file:text-sm"
              disabled={uploading}
              onChange={(event) => void pick(event.target.files?.[0])}
            />
          </div>
          <div className="flex justify-end">
            <Button
              type="submit"
              variant="outline"
              disabled={!label.trim() || !file || uploading || add.isPending}
            >
              Add
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
