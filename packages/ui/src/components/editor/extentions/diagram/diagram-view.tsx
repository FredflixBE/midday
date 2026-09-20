"use client";

import { type NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../../button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../dialog";
import { Textarea } from "../../../textarea";
import { useToast } from "../../../use-toast";
import type { DiagramOptions } from ".";
import { diagramToPng, drawDiagram } from "./render";

const STARTING_SOURCE = `flowchart LR
  A[Vandaag] --> B[Herbouw]
  B --> C[Beheer in eigen hand]`;

/** How long typing settles before the drawing is attempted again. */
const SETTLE = 400;

export function DiagramView(props: NodeViewProps) {
  const { node, updateAttributes, extension, selected } = props;
  const { images, canEdit } = extension.options as DiagramOptions;
  const source = (node.attrs.source as string) || "";
  const path = node.attrs.path as string | null;
  const src = path ? (images?.srcOf(path) ?? null) : null;

  const [open, setOpen] = useState(false);

  return (
    <NodeViewWrapper
      // A diagram at rest is the picture and nothing else. The one control
      // it has floats above it, and only while it is under the pointer or
      // holds focus — the same terms every other block control is on.
      className="group/diagram relative my-2"
      data-drag-handle
    >
      {src ? (
        // The picture, at the width of the text column, its own proportions.
        <img
          src={src}
          alt="Diagram"
          className={`max-w-full ${selected ? "outline outline-2 outline-primary" : ""}`}
        />
      ) : canEdit ? (
        // Nothing has been written yet, so the whole box is the way in. It
        // is not opened for you: a document that already holds unfinished
        // diagrams would then put a dialog on screen for each of them the
        // moment it was opened.
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex h-24 w-full items-center justify-center border border-dashed border-border text-[11px] text-[#878787] hover:text-primary"
        >
          Write a diagram
        </button>
      ) : (
        <div className="flex h-24 items-center justify-center border border-dashed border-border text-[11px] text-[#878787]">
          Diagram
        </div>
      )}

      {canEdit && src ? (
        <div className="absolute right-1 top-1 opacity-0 transition-opacity group-hover/diagram:opacity-100 focus-within:opacity-100">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-[11px]"
            onClick={() => setOpen(true)}
          >
            Edit diagram
          </Button>
        </div>
      ) : null}

      {canEdit && open ? (
        <DiagramDialog
          source={source || STARTING_SOURCE}
          images={images}
          onClose={() => setOpen(false)}
          onSave={(next) => {
            updateAttributes(next);
            setOpen(false);
          }}
        />
      ) : null}
    </NodeViewWrapper>
  );
}

function DiagramDialog({
  source: initial,
  images,
  onClose,
  onSave,
}: {
  source: string;
  images?: DiagramOptions["images"];
  onClose: () => void;
  onSave: (next: { source: string; path: string }) => void;
}) {
  const { toast } = useToast();
  const [source, setSource] = useState(initial);
  const [drawn, setDrawn] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Each drawing is numbered so a slow one landing late cannot overwrite the
  // picture of something typed after it, and so nothing is set after the
  // dialog has closed.
  const attempt = useRef(0);
  // One id for the dialog, not one per keystroke. Mermaid tidies up after a
  // drawing it could not finish by looking for what it left under the same
  // id — so a new id each time leaves the half-typed "Syntax error" it drew
  // sitting at the foot of the page, once per keystroke.
  const drawingId = `diagram-${useId().replace(/:/g, "")}`;

  useEffect(() => {
    const mine = ++attempt.current;
    const timer = setTimeout(() => {
      drawDiagram(source, drawingId)
        .then((svg) => {
          if (attempt.current !== mine) return;
          setDrawn(svg);
          setProblem(null);
        })
        .catch((error: unknown) => {
          if (attempt.current !== mine) return;
          // Mermaid says which line it could not read, which is the useful
          // half of this; the preview keeps showing the last one that worked.
          setProblem(error instanceof Error ? error.message : "Unreadable.");
        });
    }, SETTLE);
    return () => {
      clearTimeout(timer);
      // Nothing already in flight may land on a dialog that has gone.
      attempt.current++;
    };
  }, [source, drawingId]);

  const save = async () => {
    if (!images?.upload) return;
    setSaving(true);
    try {
      const svg = await drawDiagram(source, drawingId);
      const png = await diagramToPng(svg);
      const path = await images.upload(
        new File([png], "diagram.png", { type: "image/png" }),
      );
      onSave({ source, path });
    } catch (error) {
      // Nothing on screen moved and the diagram is unchanged: saying nothing
      // would read as nothing having happened.
      toast({
        title: "The diagram was not saved",
        description:
          error instanceof Error ? error.message : "Please try again.",
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      {/* `DialogContent` carries no padding of its own; every dialog in the
          app puts its own on, so this one does too. */}
      <DialogContent className="max-w-4xl">
        <div className="space-y-4 p-4">
          <DialogHeader>
            <DialogTitle>Diagram</DialogTitle>
            <DialogDescription className="sr-only">
              Write the diagram in mermaid; it is drawn as you type.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-4">
            <Textarea
              value={source}
              onChange={(event) => setSource(event.target.value)}
              className="h-80 resize-none font-mono text-[11px]"
              spellCheck={false}
              // The dialog is opened to write in, so the caret starts here.
              autoFocus
            />
            <div className="flex h-80 items-center justify-center overflow-auto border border-border p-2">
              {drawn ? (
                // Mermaid's own output, which is why it is set rather than
                // built: nothing reaches this that has not been through
                // mermaid's parser first, and it never leaves the dialog — a
                // picture is what is stored and what anyone else ever sees.
                <div
                  className="[&>svg]:max-h-full [&>svg]:max-w-full"
                  dangerouslySetInnerHTML={{ __html: drawn }}
                />
              ) : (
                <span className="text-[11px] text-[#878787]">
                  Nothing drawn yet
                </span>
              )}
            </div>
          </div>

          {problem ? (
            <p className="text-[11px] text-[#FF3638]">{problem}</p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={save}
              // Nothing readable to draw, so nothing to store a picture of.
              disabled={saving || !drawn || !images?.upload}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
