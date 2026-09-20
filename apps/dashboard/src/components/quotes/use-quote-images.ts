"use client";

import type { StoredImages } from "@midday/ui/editor";
import { useCallback, useMemo, useRef } from "react";
import { useUserQuery } from "@/hooks/use-user";
import { uploadToQuotes } from "./upload-to-quotes";

/** Big enough for a screenshot or a mock-up, small enough to send. */
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * What the PDF can draw. The file dialog is told the same, but that is only
 * a hint it will let you past, and a picture the editor shows and the PDF
 * silently drops is worse than one that was never added.
 */
const TYPES: Record<string, string | undefined> = {
  "image/png": "png",
  "image/jpeg": "jpg",
};

/**
 * The pictures a quote's text may hold (FF-1625). They live in the `vault`
 * bucket under the team, the way documents do, and the text keeps the path
 * they were stored under — never a public address, so a picture is only
 * reachable with the team's own file key.
 *
 * `uploadToQuotes` gives each upload a name of its own, which is what keeps
 * two screenshots of the same name from replacing one another.
 *
 * What this returns never changes and is never absent, which matters more
 * than it looks: the editor builds its schema from it once, and a schema
 * without the picture node would quietly drop every picture in the text it
 * was handed. So the team is read through a ref rather than closed over.
 */
export function useQuoteImages(): StoredImages & { ready: boolean } {
  const { data: user } = useUserQuery();

  const team = useRef<{ teamId?: string | null; fileKey?: string | null }>({});
  team.current = { teamId: user?.teamId, fileKey: user?.fileKey };

  const srcOf = useCallback((path: string) => {
    const { fileKey } = team.current;
    if (!fileKey) return null;

    const url = new URL(`${process.env.NEXT_PUBLIC_API_URL}/files/proxy`);
    url.searchParams.set("filePath", path);
    url.searchParams.set("fk", fileKey);
    return url.toString();
  }, []);

  const upload = useCallback(async (file: File) => {
    // What is thrown here is read out to whoever picked the file, so it is
    // written for them and said once, where the picture was asked for.
    const { teamId } = team.current;
    if (!teamId) {
      throw new Error("Your team is still loading. Please try again.");
    }

    if (file.size > MAX_BYTES) {
      throw new Error("Pictures in a quote are up to 10 MB.");
    }

    if (!TYPES[file.type]) {
      throw new Error("A quote holds PNG and JPEG pictures.");
    }

    return (await uploadToQuotes(teamId, file)).join("/");
  }, []);

  const images = useMemo(() => ({ srcOf, upload }), [srcOf, upload]);

  // False only while the team is still being read; the addresses a picture is
  // shown from are made once, so the editor is mounted again when it lands.
  return { ...images, ready: Boolean(user?.fileKey && user?.teamId) };
}
