"use client";

import { cn } from "@midday/ui/cn";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { lazy, Suspense } from "react";
import { useInvoiceParams } from "@/hooks/use-invoice-params";

// The invoice form behind the canvas (Tiptap, line items) loads only when the
// canvas opens (FF-1712).
const InvoiceCanvasContent = lazy(() =>
  import("./invoice-canvas-content").then((m) => ({
    default: m.InvoiceCanvasContent,
  })),
);

export function ChatInvoiceCanvas() {
  const { canvas } = useInvoiceParams();
  const isOpen = canvas === true;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ x: "100%" }}
          animate={{ x: 0 }}
          exit={{ x: "100%" }}
          transition={{ type: "spring", stiffness: 400, damping: 40 }}
          className={cn(
            "fixed top-0 md:top-[70px] right-0 bottom-0 z-40",
            "w-full md:w-[650px]",
            "bg-background",
            "border-l border-border",
            "will-change-transform",
          )}
        >
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            }
          >
            <InvoiceCanvasContent />
          </Suspense>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
