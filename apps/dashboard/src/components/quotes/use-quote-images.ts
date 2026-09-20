"use client";

import { createClient } from "@midday/supabase/client";
import type { StoredImages } from "@midday/ui/editor";
import { useToast } from "@midday/ui/use-toast";
import { useCallback, useMemo, useRef } from "react";
import { useUserQuery } from "@/hooks/use-user";
import { resumableUpload } from "@/utils/upload";

/** Big enough for a screenshot or a mock-up, small enough to send. */
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * The pictures a quote's text may hold (FF-1625). They live in the `vault`
 * bucket under the team, the way documents do, and the text keeps the path
 * they were stored under — never a public address, so a picture is only
 * reachable with the team's own file key.
 *
 * Each upload gets a name of its own rather than the file's, because storage
 * writes are upserts: two screenshots called the same thing would otherwise
 * overwrite each other, and the second would silently replace the picture in
 * a version that had already been sent.
 *
 * What this returns never changes and is never absent, which matters more
 * than it looks: the editor builds its schema from it once, and a schema
 * without the picture node would quietly drop every picture in the text it
 * was handed. So the team is read through a ref rather than closed over.
 */
export function useQuoteImages(): StoredImages & { ready: boolean } {
  const { data: user } = useUserQuery();
  const { toast } = useToast();

  const team = useRef<{ teamId?: string | null; fileKey?: string | null }>({});
  team.current = { teamId: user?.teamId, fileKey: user?.fileKey };

  const toastRef = useRef(toast);
  toastRef.current = toast;

  const srcOf = useCallback((path: string) => {
    const { fileKey } = team.current;
    if (!fileKey) return null;

    const url = new URL(`${process.env.NEXT_PUBLIC_API_URL}/files/proxy`);
    url.searchParams.set("filePath", path);
    url.searchParams.set("fk", fileKey);
    return url.toString();
  }, []);

  const upload = useCallback(async (file: File) => {
    const { teamId } = team.current;
    if (!teamId) {
      throw new Error("No team to store the picture under");
    }

    if (file.size > MAX_BYTES) {
      toastRef.current({
        title: "That picture is too big",
        description: "Pictures in a quote are up to 10 MB.",
        variant: "error",
      });
      throw new Error("Image too large");
    }

    const extension = file.name.split(".").pop()?.toLowerCase() || "png";
    const named = new File([file], `${crypto.randomUUID()}.${extension}`, {
      type: file.type,
    });
    const folder = [teamId, "quotes"];
    await resumableUpload(createClient(), {
      bucket: "vault",
      path: folder,
      file: named,
    });
    return [...folder, named.name].join("/");
  }, []);

  const images = useMemo(() => ({ srcOf, upload }), [srcOf, upload]);

  // False only while the team is still being read; the addresses a picture is
  // shown from are made once, so the editor is mounted again when it lands.
  return { ...images, ready: Boolean(user?.fileKey) };
}
