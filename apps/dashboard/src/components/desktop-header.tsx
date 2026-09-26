"use client";

import { isDesktopApp } from "@midday/desktop-client/platform";
import { usePathname } from "next/navigation";
import { DesktopTrafficLight } from "./desktop-traffic-light";

// The shell's user agent names no OS, and WKWebView reports "MacIntel" on
// Apple silicon too. Client-only: DesktopHeader never renders on the server.
function isMac() {
  return navigator.platform.startsWith("Mac");
}

export function DesktopHeader() {
  const pathname = usePathname();

  if (!isDesktopApp() || !isMac() || pathname.includes("/search")) {
    return null;
  }

  // The window is borderless on macOS only, so this strip is its title bar:
  // the drag region and the traffic lights. Windows keeps its native title bar.
  return (
    <div
      data-tauri-drag-region
      className="absolute top-0 left-0 right-0 h-5 z-[51] group border-radius-[10px] overflow-hidden"
    >
      <div className="hidden group-hover:flex">
        <DesktopTrafficLight />
      </div>
    </div>
  );
}
