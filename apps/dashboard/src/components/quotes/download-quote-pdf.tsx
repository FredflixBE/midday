"use client";

import { quotePdfFilename } from "@midday/quote";
import { Button } from "@midday/ui/button";
import { Download } from "lucide-react";
import { useState } from "react";
import { useUserQuery } from "@/hooks/use-user";
import { downloadFile } from "@/lib/download";

/** Where a quote version's PDF is served (FF-1613). */
function quotePdfUrl(versionId: string, fileKey: string) {
  const url = new URL(
    `${process.env.NEXT_PUBLIC_API_URL}/files/download/quote`,
  );
  url.searchParams.set("id", versionId);
  url.searchParams.set("fk", fileKey);
  return url.toString();
}

/**
 * Downloads a version as a PDF. A draft is saved first, so the PDF has
 * what is on screen; `saved` resolves false when the save was refused.
 */
export function DownloadQuotePdf({
  versionId,
  quoteNumber,
  version,
  saved,
  compact = false,
}: {
  versionId: string;
  quoteNumber: string;
  version: number;
  saved?: () => Promise<boolean>;
  /** An icon only, as in a list row. */
  compact?: boolean;
}) {
  const { data: user } = useUserQuery();
  const [busy, setBusy] = useState(false);

  const download = async () => {
    if (!user?.fileKey) return;
    setBusy(true);
    try {
      if (saved && !(await saved())) return;
      await downloadFile(
        quotePdfUrl(versionId, user.fileKey),
        quotePdfFilename(quoteNumber, version),
      );
    } finally {
      setBusy(false);
    }
  };

  return compact ? (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Download PDF"
      disabled={busy || !user?.fileKey}
      onClick={(event) => {
        // The row opens the quote; this does not.
        event.stopPropagation();
        void download();
      }}
    >
      <Download size={14} />
    </Button>
  ) : (
    <Button
      type="button"
      variant="outline"
      disabled={busy || !user?.fileKey}
      onClick={() => void download()}
    >
      Download PDF
    </Button>
  );
}
