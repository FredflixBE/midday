"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { useExportStore } from "@/store/export";

// The toast follows a running export over a Trigger.dev subscription, and
// that client is about 1 MB unminified. It loads when an export first starts
// and then stays mounted, so the toast can still finish after the store is
// cleared (FF-1724).
const ExportStatusToast = dynamic(
  () => import("./export-status-toast").then((mod) => mod.ExportStatusToast),
  { ssr: false },
);

export function ExportStatus() {
  const running = useExportStore((state) => Boolean(state.exportData?.runId));
  const [started, setStarted] = useState(running);

  if (running && !started) {
    setStarted(true);
  }

  return started || running ? <ExportStatusToast /> : null;
}
