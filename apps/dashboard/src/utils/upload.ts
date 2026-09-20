import { inboxFileName, stripSpecialCharacters } from "@midday/utils";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as tus from "tus-js-client";

type ResumableUploadParmas = {
  file: File;
  path: string[];
  bucket: string;
  onProgress?: (bytesUploaded: number, bytesTotal: number) => void;
};

export async function resumableUpload(
  client: SupabaseClient,
  { file, path, bucket, onProgress }: ResumableUploadParmas,
) {
  const {
    data: { session },
  } = await client.auth.getSession();

  const filename = stripSpecialCharacters(file.name);

  const fullPath = decodeURIComponent([...path, filename].join("/"));

  return new Promise((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/upload/resumable`,
      retryDelays: [0, 3000, 5000, 10000],
      headers: {
        authorization: `Bearer ${session?.access_token}`,
        // optionally set upsert to true to overwrite existing files
        "x-upsert": "true",
      },
      uploadDataDuringCreation: true,
      // Important if you want to allow re-uploading the same file https://github.com/tus/tus-js-client/blob/main/docs/api.md#removefingerprintonsuccess
      removeFingerprintOnSuccess: true,
      metadata: {
        bucketName: bucket,
        objectName: fullPath,
        contentType: file.type,
        cacheControl: "3600",
      },
      // NOTE: it must be set to 6MB (for now) do not change it
      chunkSize: 6 * 1024 * 1024,
      onError: (error) => {
        reject(error);
      },
      onProgress,
      onSuccess: () => {
        resolve({
          ...upload,
          filename,
        });
      },
    });

    // Check if there are any previous uploads to continue.
    return upload.findPreviousUploads().then((previousUploads) => {
      // Found previous uploads so we select the first one.
      if (previousUploads.length) {
        // @ts-expect-error
        upload.resumeFromPreviousUpload(previousUploads[0]);
      }

      upload.start();
    });
  });
}

/**
 * The same file, renamed to one the team's inbox holds on its own.
 *
 * The inbox is a single flat folder per team and the upload above upserts, so
 * two receipts called `invoice.pdf` — the ordinary case for a vendor that
 * bills monthly — would share one object, and the first receipt would be lost
 * behind an inbox item that still describes it (FF-1508). Renaming the file
 * is enough to stop it: the object key is derived from `file.name`.
 *
 * The name is stripped before the suffix is added, so the strip this uploader
 * does on its way through leaves the result alone. That is what lets a caller
 * register the inbox item under this name and know the file lands there.
 */
export function withInboxFileName(file: File): File {
  const name = inboxFileName({
    filename: stripSpecialCharacters(file.name),
    mimeType: file.type,
  });

  return new File([file], name, {
    type: file.type,
    lastModified: file.lastModified,
  });
}
