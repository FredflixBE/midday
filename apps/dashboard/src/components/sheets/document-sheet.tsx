"use client";

import { Sheet, SheetContent, SheetTitle } from "@midday/ui/sheet";
import { DocumentDetails } from "@/components/document-details";
import { useDocumentParams } from "@/hooks/use-document-params";

export function DocumentSheet() {
  const { params, setParams } = useDocumentParams();

  const isOpen = Boolean(params.filePath || params.documentId);

  return (
    <Sheet
      open={isOpen}
      onOpenChange={() => setParams({ documentId: null, filePath: null })}
    >
      <SheetContent style={{ maxWidth: 647 }}>
        <SheetTitle className="sr-only">Document details</SheetTitle>

        <DocumentDetails />
      </SheetContent>
    </Sheet>
  );
}
