export const EMPTY_FOLDER_PLACEHOLDER_FILE_NAME = ".emptyFolderPlaceholder";

// The most paths Storage lists or removes in one call.
const STORAGE_PAGE_SIZE = 1000;

type StorageClient = {
  storage: {
    from(bucket: string): any;
  };
};

type UploadParams = {
  file: File;
  path: string[];
  bucket: string;
};

export async function upload(
  client: StorageClient,
  { file, path, bucket }: UploadParams,
) {
  const storage = client.storage.from(bucket);

  const result = await storage.upload(path.join("/"), file, {
    upsert: true,
    cacheControl: "3600",
  });

  if (!result.error) {
    return storage.getPublicUrl(path.join("/")).data.publicUrl;
  }

  throw result.error;
}

type RemoveParams = {
  path: string[];
  bucket: string;
};

export async function remove(
  client: StorageClient,
  { bucket, path }: RemoveParams,
) {
  return client.storage
    .from(bucket)
    .remove([decodeURIComponent(path.join("/"))]);
}

type RemoveFolderParams = {
  path: string[];
  bucket: string;
};

/**
 * Remove every file under a folder, however deeply nested, and return how many
 * there were.
 *
 * Storage has no call that deletes a prefix: `list` returns one level at a
 * time, with each sub-folder as an entry that has no id, and `remove` takes a
 * list of file paths. So this walks the tree first and removes afterwards.
 */
export async function removeFolder(
  client: StorageClient,
  { bucket, path }: RemoveFolderParams,
): Promise<number> {
  const storage = client.storage.from(bucket);
  const files: string[] = [];
  const folders = [path.join("/")];

  for (let folder = folders.pop(); folder; folder = folders.pop()) {
    for (let offset = 0; ; offset += STORAGE_PAGE_SIZE) {
      const { data, error } = await storage.list(folder, {
        limit: STORAGE_PAGE_SIZE,
        offset,
      });

      if (error) throw error;

      for (const entry of data as { name: string; id: string | null }[]) {
        const entryPath = `${folder}/${entry.name}`;

        if (entry.id === null) {
          folders.push(entryPath);
        } else {
          files.push(entryPath);
        }
      }

      if (data.length < STORAGE_PAGE_SIZE) break;
    }
  }

  for (let start = 0; start < files.length; start += STORAGE_PAGE_SIZE) {
    const { error } = await storage.remove(
      files.slice(start, start + STORAGE_PAGE_SIZE),
    );

    if (error) throw error;
  }

  return files.length;
}

type DownloadParams = {
  path: string;
  bucket: string;
};

export async function download(
  client: StorageClient,
  { bucket, path }: DownloadParams,
) {
  return client.storage.from(bucket).download(path);
}

type SignedUrlParams = {
  path: string;
  bucket: string;
  expireIn: number;
  options?: {
    download?: boolean;
  };
};

export async function signedUrl(
  client: StorageClient,
  { bucket, path, expireIn, options }: SignedUrlParams,
) {
  return client.storage.from(bucket).createSignedUrl(path, expireIn, options);
}
