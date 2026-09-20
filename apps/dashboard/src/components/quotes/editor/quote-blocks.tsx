"use client";

import type { Block, QuoteContent } from "@midday/quote";
import { Button } from "@midday/ui/button";
import { cn } from "@midday/ui/cn";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@midday/ui/dialog";
import { Editor } from "@midday/ui/editor";
import { Input } from "@midday/ui/input";
import { Maximize2, Trash2 } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import type { DraftChange } from "../use-quote-draft";
import { useQuoteImages } from "../use-quote-images";
import { SortableList, SortableRow } from "./sortable";

type TextBlock = Extract<Block, { type: "text" }>;

const EMPTY_DOC: TextBlock["body"] = { type: "doc", content: [] };

/**
 * The proposal text: blocks in the order they are printed, each with an
 * optional heading, and the pricing block marking where the scenarios go.
 */
export function QuoteBlocks({
  content,
  change,
  editable,
}: {
  content: QuoteContent;
  change: (next: DraftChange) => void;
  editable: boolean;
}) {
  const setBlocks = (blocks: (current: Block[]) => Block[]) =>
    change((d) => ({
      content: { ...d.content, blocks: blocks(d.content.blocks) },
    }));

  const updateBlock = (id: string, patch: Partial<TextBlock>) =>
    setBlocks((blocks) =>
      blocks.map((block) =>
        block.id === id && block.type === "text"
          ? { ...block, ...patch }
          : block,
      ),
    );

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">Text</h2>

      <SortableList
        items={content.blocks}
        disabled={!editable}
        onReorder={(blocks) => setBlocks(() => blocks)}
      >
        <div className="space-y-3">
          {content.blocks.map((block) =>
            block.type === "pricing" ? (
              <SortableRow key={block.id} id={block.id} label="Pricing">
                {(handle) => (
                  <div className="flex items-center gap-3 border border-dashed border-border px-3 py-2 text-sm text-[#878787]">
                    {handle}
                    Pricing
                  </div>
                )}
              </SortableRow>
            ) : (
              <SortableRow
                key={block.id}
                id={block.id}
                label={block.heading || "text block"}
              >
                {(handle) => (
                  <TextBlockEditor
                    block={block}
                    handle={handle}
                    editable={editable}
                    onChange={(patch) => updateBlock(block.id, patch)}
                    onRemove={() =>
                      setBlocks((blocks) =>
                        blocks.filter((b) => b.id !== block.id),
                      )
                    }
                  />
                )}
              </SortableRow>
            ),
          )}
        </div>
      </SortableList>

      {editable ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            setBlocks((blocks) => [
              ...blocks,
              {
                id: crypto.randomUUID(),
                type: "text",
                heading: null,
                body: EMPTY_DOC,
              },
            ])
          }
        >
          Add text block
        </Button>
      ) : null}
    </section>
  );
}

// What the text reads like wherever it is written. Tailwind's reset flattens
// headings and lists; the PDF shows them, so should this.
const TEXT_STYLES = cn(
  "text-sm leading-relaxed",
  "[&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5",
  "[&_.tiptap_h1]:mb-0 [&_.tiptap_h1]:text-base [&_.tiptap_h1]:font-medium",
  "[&_.tiptap_h2]:mb-0 [&_.tiptap_h2]:text-sm [&_.tiptap_h2]:font-medium",
  "[&_.tiptap_h3]:font-medium",
);

function TextBlockEditor({
  block,
  handle,
  editable,
  onChange,
  onRemove,
}: {
  block: TextBlock;
  handle: ReactNode;
  editable: boolean;
  onChange: (patch: Partial<TextBlock>) => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const images = useQuoteImages();
  const body = useRef<HTMLDivElement>(null);
  // What the block stood at when it was expanded, so the page behind the
  // dialog does not collapse and shift everything under it.
  const [heldHeight, setHeldHeight] = useState<number>();

  /**
   * The one editor this block has (FF-1624). Expanding moves it into the
   * dialog and closing moves it back: Tiptap keeps its state per instance, so
   * only ever one holds the text, and each mount is seeded from the draft the
   * last one wrote.
   */
  const renderEditor = (className: string, autoFocus = false) => (
    <Editor
      // A picture is shown from an address made when the editor is built, so
      // one built before the team was read shows none: build it again.
      key={images.ready ? "ready" : "waiting"}
      initialContent={block.body}
      editable={editable}
      toolbar
      images={images}
      autoFocus={autoFocus}
      className={className}
      onUpdate={(editor) =>
        onChange({
          body: (editor.isEmpty
            ? EMPTY_DOC
            : editor.getJSON()) as TextBlock["body"],
        })
      }
    />
  );

  const expand = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Expand block"
      onClick={() => {
        setHeldHeight(body.current?.offsetHeight);
        setExpanded(true);
      }}
    >
      <Maximize2 size={14} />
    </Button>
  );

  return (
    <div className={cn("group relative", editable && "border border-border")}>
      {editable ? (
        <div className="flex items-center gap-3 border-b border-border px-3 py-1">
          {handle}
          <Input
            aria-label="Heading"
            placeholder="Heading"
            value={block.heading ?? ""}
            maxLength={500}
            className="h-8 flex-1 border-0 px-0 font-medium focus-visible:ring-0"
            onChange={(event) =>
              onChange({ heading: event.target.value || null })
            }
          />
          {expand}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Remove block"
            onClick={onRemove}
          >
            <Trash2 size={14} />
          </Button>
        </div>
      ) : (
        // A version that cannot be edited keeps none of the chrome that says
        // it can (FF-1631, closing FF-1628): no box, no field for the
        // heading, nothing to type into. Expanding is still how it is read
        // full screen (FF-1624), so that one control stays — out of the
        // text's way until the block is under the pointer or holds focus.
        <>
          {block.heading ? (
            <h3 className="pr-10 text-base font-medium">{block.heading}</h3>
          ) : null}
          <div className="absolute right-0 top-0 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
            {expand}
          </div>
        </>
      )}

      <div ref={body}>
        {expanded ? (
          <div style={{ height: heldHeight }} />
        ) : (
          renderEditor(
            cn(editable ? "min-h-[72px] px-3 py-2" : "py-1", TEXT_STYLES),
          )
        )}
      </div>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          className="flex h-[90svh] max-h-none w-[92vw] max-w-4xl flex-col overflow-y-hidden p-0"
          // The heading is the whole of it; there is nothing to describe.
          aria-describedby={undefined}
          // The caret belongs in the text, not on the first toolbar button.
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <DialogHeader className="border-b border-border px-6 py-4">
            <DialogTitle>{block.heading || "Text block"}</DialogTitle>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Radix keeps the dialog mounted while it animates shut, and by
                then the page holds the editor again: this guard is what keeps
                it to one. */}
            {expanded
              ? renderEditor(
                  cn("min-h-0 flex-1 overflow-y-auto px-6 py-4", TEXT_STYLES),
                  true,
                )
              : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
