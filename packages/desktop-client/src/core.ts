export { invoke } from "@tauri-apps/api/core";
export { emit, listen } from "@tauri-apps/api/event";
export { getCurrentWindow, Window } from "@tauri-apps/api/window";
export { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Show `text` as a native notification. Clicking it brings the window forward
 * and opens `path` (a dashboard path such as `/inbox`), the way an hq:// link
 * does. Handled by the shell's `notify` command, which shows nothing while the
 * window is in use unless `evenInForeground`.
 */
export async function showDesktopNotification(
  text: string,
  path: string,
  { evenInForeground = false }: { evenInForeground?: boolean } = {},
) {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("notify", { text, path, evenInForeground });
}

/**
 * Write a Blob to a user-selected location via save dialog.
 */
export async function nativeSaveFile(blob: Blob, filename: string) {
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { open } = await import("@tauri-apps/plugin-fs");
    const { downloadDir } = await import("@tauri-apps/api/path");

    console.log("[nativeSaveFile] Starting file save:", {
      filename,
      blobSize: blob.size,
      blobType: blob.type,
    });

    if (!blob || blob.size === 0) {
      throw new Error("Blob is empty or invalid");
    }

    const buffer = await blob.arrayBuffer();
    console.log("[nativeSaveFile] Converted blob to buffer:", {
      bufferSize: buffer.byteLength,
    });

    if (buffer.byteLength === 0) {
      throw new Error("Buffer is empty after conversion");
    }

    // Extract file extension for filter
    const extension = filename.split(".").pop()?.toLowerCase() || "";
    const filters = extension
      ? [{ name: "Files", extensions: [extension] }]
      : undefined;

    // Show save dialog with default path in Downloads folder
    const defaultPath = `${await downloadDir()}/${filename}`;
    const selectedPath = await save({
      defaultPath,
      filters,
      title: "Save File",
    });

    if (!selectedPath) {
      // User cancelled the dialog
      console.log("[nativeSaveFile] User cancelled save dialog");
      return;
    }

    // Write file to selected path
    // The save dialog automatically adds the path to filesystem scope
    // Use open() with write/create/truncate flags for reliable file writing
    const file = await open(selectedPath, {
      write: true,
      create: true,
      truncate: true,
    });
    await file.write(new Uint8Array(buffer));
    await file.close();

    console.log("[nativeSaveFile] File saved successfully:", selectedPath);

    // Show the saved file selected in Finder or Explorer. revealItemInDir takes
    // the file's own path on either system; opener:default permits it, where a
    // file:// URL is refused.
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(selectedPath);
    } catch (error) {
      // Ignore errors - revealing file is optional
      console.log("[nativeSaveFile] Could not reveal file:", error);
    }
  } catch (error) {
    console.error("[nativeSaveFile] Error saving file:", error);
    throw error;
  }
}
