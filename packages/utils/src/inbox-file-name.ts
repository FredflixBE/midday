import { ensureFileExtension } from "./mime-to-extension";

/**
 * The characters Supabase Storage accepts in an object key; it answers any
 * other with "Invalid key". Mirrors `isValidKey` in storage-api, less the
 * separator: what this module makes is one segment of a key, and a document
 * called `2026/09.pdf` must not become a folder.
 */
const STORAGE_KEY_CHARACTER = /[\w!\-.*'() &$@=;:+,?]/;

const FILE_EXTENSION = /\.[^.]+$/;

/**
 * A file name Storage accepts: accents dropped (é → e), and whatever it would
 * still refuse replaced by an underscore.
 */
function storageSafeFileName(name: string): string {
  return Array.from(name.normalize("NFKD").replace(/\p{M}/gu, ""))
    .map((character) =>
      STORAGE_KEY_CHARACTER.test(character) ? character : "_",
    )
    .join("");
}

/** Eight hex characters, enough that two uploads never meet. */
function randomSuffix(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * The name a document is stored under in the team's inbox folder, for every
 * way a document gets there: a dashboard upload, a forwarded email, a Slack
 * file, a synced mailbox attachment.
 *
 * A team's inbox is one flat folder and a storage write is an upsert, so two
 * documents called `invoice.pdf` — the ordinary case for a vendor that bills
 * monthly — would otherwise share one file, and the first invoice would be
 * lost while the inbox item that describes it stayed. The suffix is what
 * keeps them apart, and the name is made safe for a Storage key on the way,
 * which a name like `Rechnung Müller.pdf` is not.
 *
 * Pass a `suffix` where the caller can be run twice over the same document —
 * a re-sync, a job retry — so the second run writes the same file instead of
 * a second copy. Without one the suffix is random, which is right for an
 * upload that happens once.
 */
export function inboxFileName({
  filename,
  mimeType,
  suffix,
}: {
  filename: string;
  mimeType: string;
  suffix?: string;
}): string {
  const name = ensureFileExtension(filename, mimeType);
  const extension = name.match(FILE_EXTENSION)?.[0] ?? "";
  const stem = name.slice(0, name.length - extension.length);

  return storageSafeFileName(`${stem}_${suffix ?? randomSuffix()}${extension}`);
}
