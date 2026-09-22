"use client";

import { createClient } from "@midday/supabase/client";
import { resumableUpload } from "@/utils/upload";

/**
 * Stores a file under the team's quotes folder in the `vault` bucket and
 * gives back the path tokens it was stored under. Everything a quote keeps —
 * the pictures in its text (FF-1625), the order form attached when
 * acceptance is recorded and the team's general terms (FF-1615, FF-1616) —
 * goes through here.
 *
 * Each upload is written under a name of its own rather than the file's,
 * because storage writes are upserts: two screenshots called `diagram.png`,
 * or two order forms called `scan.pdf`, would otherwise overwrite each other
 * and silently replace what a version already sent points at.
 *
 * `subfolder` is what keeps the kinds apart (FF-1634). Pictures go under
 * `images/`; the stored PDF of a sent version, the order form and the
 * general terms stay in `quotes/` itself. A sweep over the pictures folder
 * therefore cannot reach a file that two other tickets exist to keep, which
 * is the whole reason the folder is there.
 */
export async function uploadToQuotes(
  teamId: string,
  file: File,
  subfolder?: string,
) {
  const extension = file.name.split(".").pop();
  const name = extension
    ? `${crypto.randomUUID()}.${extension}`
    : crypto.randomUUID();

  const folder = subfolder ? [teamId, "quotes", subfolder] : [teamId, "quotes"];
  await resumableUpload(createClient(), {
    bucket: "vault",
    path: folder,
    file: new File([file], name, { type: file.type }),
  });

  return [...folder, name];
}
