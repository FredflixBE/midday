"use client";

import type { Block, QuoteContent } from "@midday/quote";
import type { ComparisonView, ScenarioView } from "@midday/quote/view";
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
import { ChevronDown, Heading1, Maximize2, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { DraftChange } from "../use-quote-draft";
import { useQuoteImages } from "../use-quote-images";
import { PricingPreview } from "./pricing-preview";
import { SortableList, SortableRow } from "./sortable";

type TextBlock = Extract<Block, { type: "text" }>;

const EMPTY_DOC: TextBlock["body"] = { type: "doc", content: [] };

/**
 * What an empty block is opened on. A document with no content at all gives
 * Tiptap no paragraph to put the caret in — you get a gap cursor and no
 * placeholder — so the editor is seeded with one. Nothing is stored until
 * something is typed: an emptied block is saved as `EMPTY_DOC` again.
 */
const ONE_EMPTY_PARAGRAPH: TextBlock["body"] = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

/**
 * The measure of the PDF's text column at the size this draws it: A4 less its
 * margins is 515pt of 9pt text, which is 800px of 14px text. The page is the
 * preview, so a line here breaks roughly where a line there does.
 */
export const DOCUMENT_WIDTH = "max-w-[800px]";

/**
 * The proposal text: blocks in the order they are printed, each with an
 * optional heading, and the pricing block marking where the scenarios go.
 */
export function QuoteBlocks({
  content,
  change,
  editable,
  pricing,
}: {
  content: QuoteContent;
  change: (next: DraftChange) => void;
  editable: boolean;
  /** The priced scenarios as they print, for the block that stands where
      they go. */
  pricing: { comparison: ComparisonView | null; scenarios: ScenarioView[] };
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
    <section className={cn(DOCUMENT_WIDTH, "space-y-10")}>
      <SortableList
        items={content.blocks}
        disabled={!editable}
        onReorder={(blocks) => setBlocks(() => blocks)}
      >
        <div className="space-y-10">
          {content.blocks.map((block) =>
            block.type === "pricing" ? (
              <SortableRow key={block.id} id={block.id} label="Pricing">
                {(handle, dragging) => (
                  <PricingBlock
                    handle={editable ? handle : null}
                    pricing={pricing}
                    dragging={dragging}
                  />
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

/**
 * Where the priced scenarios print, showing what they say (FF-1640). Open,
 * it is the comparison table and the scenarios as the PDF lays them out;
 * shut, it is the line it used to be. Either way it drags, because its place
 * among the text is what decides where the tables go, and it is the only
 * thing that decides it.
 *
 * Nothing is edited or reached from here: the Pricing tab is where the
 * numbers are changed, and the tab strip is the way to it.
 */
function PricingBlock({
  handle,
  pricing,
  dragging,
}: {
  handle: ReactNode;
  pricing: { comparison: ComparisonView | null; scenarios: ScenarioView[] };
  /** True while it is being moved: a block the height of a page is not one
      you can drop where you meant to. */
  dragging: boolean;
}) {
  const [open, setOpen] = useState(true);
  const empty = pricing.scenarios.length === 0;

  return (
    <div className="border border-dashed border-border">
      <div className="flex items-center gap-3 px-3 py-2 text-sm text-[#878787]">
        {handle}
        <span className="flex-1">Pricing</span>
        {/* On the right, where every other thing that opens and shuts on
            this page has its chevron. */}
        <button
          type="button"
          aria-label={open ? "Collapse the pricing" : "Expand the pricing"}
          className="shrink-0 hover:text-primary focus-visible:text-primary focus-visible:outline-none"
          onClick={() => setOpen(!open)}
        >
          <ChevronDown
            size={14}
            className={cn("transition-transform", open && "rotate-180")}
          />
        </button>
      </div>
      {open && !empty && !dragging ? (
        <div className="border-t border-dashed border-border px-3 py-4">
          <PricingPreview
            comparison={pricing.comparison}
            scenarios={pricing.scenarios}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * What the text reads like wherever it is written (FF-1633). Tailwind's reset
 * flattens headings and lists, and the editor's own stylesheet sizes them for
 * an invoice's few lines of address text; a quote is a document, so the sizes
 * come from the PDF instead.
 *
 * `packages/quote/src/pdf/template.tsx` and the shared
 * `formatEditorContent` decide what the client actually holds: 9pt body,
 * headings at 14, 12 and 10pt, lists indented by 12pt. At 14px body that is
 * the scale below. The PDF is the reference; this borrows its proportions
 * and does not repeat its logic.
 */
const TEXT_STYLES = cn(
  "text-sm leading-[1.55]",
  "[&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5",
  "[&_.tiptap_h1]:mb-1 [&_.tiptap_h1]:mt-2 [&_.tiptap_h1]:text-[22px] [&_.tiptap_h1]:font-medium [&_.tiptap_h1]:leading-snug",
  "[&_.tiptap_h2]:mb-1 [&_.tiptap_h2]:mt-2 [&_.tiptap_h2]:text-[19px] [&_.tiptap_h2]:font-medium [&_.tiptap_h2]:leading-snug",
  "[&_.tiptap_h3]:mb-1 [&_.tiptap_h3]:mt-2 [&_.tiptap_h3]:text-base [&_.tiptap_h3]:font-medium",
  // The editor sets its own size and a loose leading for invoice text.
  "[&_.tiptap]:text-sm [&_.tiptap]:leading-[1.55]",
  // How to start, on the line being written and nowhere else (FF-1649). The
  // extension marks only the node the caret is in, and the focused editor is
  // the only one that draws it — so a document of empty blocks is empty
  // rather than a column of repeated instructions.
  "[&_.tiptap.ProseMirror-focused_p.is-empty]:before:pointer-events-none",
  "[&_.tiptap.ProseMirror-focused_p.is-empty]:before:float-left",
  "[&_.tiptap.ProseMirror-focused_p.is-empty]:before:h-0",
  "[&_.tiptap.ProseMirror-focused_p.is-empty]:before:text-[#878787]",
  "[&_.tiptap.ProseMirror-focused_p.is-empty]:before:content-[attr(data-placeholder)]",
);

/** A block's own heading, which the PDF sets at the size of an h1. */
const HEADING_STYLES = "text-[22px] font-medium leading-snug";

/**
 * A block's controls — its grip, expand and remove — out of sight until they
 * are wanted, so a quote at rest reads as a quote (FF-1633).
 *
 * They take no pointer events while hidden, so an invisible button can never
 * swallow a click or a drag through the text, and a device with no pointer to
 * hover with shows them always rather than hiding them for good. They float
 * above the block, so revealing them shifts no line of text.
 */
const CONTROLS = cn(
  // No gap under the bar: a few pixels of nothing between it and the block
  // is a trap, because crossing them slowly ends the hover and the bar stops
  // taking the pointer before the pointer arrives.
  "quote-block-control absolute bottom-full right-0 z-10 border border-border bg-background",
  "pointer-events-none opacity-0 transition-opacity",
  "group-hover:pointer-events-auto group-hover:opacity-100",
  "group-focus-within:pointer-events-auto group-focus-within:opacity-100",
  "[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100",
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
  // A heading asked for but not yet typed. An empty heading is not part of
  // the document, so this is not saved — it only decides whether the line is
  // on screen waiting to be typed into (FF-1649).
  const [headingWanted, setHeadingWanted] = useState(false);
  const headingBox = useRef<HTMLInputElement>(null);
  // After the line is on screen, not before: the ref is only attached once
  // React has committed, so focusing on the click itself finds nothing.
  useEffect(() => {
    if (headingWanted) headingBox.current?.focus();
  }, [headingWanted]);
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
      initialContent={
        block.body.content?.length ? block.body : ONE_EMPTY_PARAGRAPH
      }
      editable={editable}
      // Nothing to reach for: "/" offers what a block can hold, and the
      // bubble menu marks up what is already selected (FF-1638).
      slashMenu
      placeholder="Type '/' for commands"
      images={images}
      // A quote lays out comparison tables and draws diagrams; an invoice
      // note does neither (FF-1642, FF-1643).
      tables
      diagrams
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

  return (
    // A block at rest is the document and nothing else (FF-1633). The
    // controls it has — the grip, expand, remove — float above it, and only
    // while it is under the pointer or holds focus. A device with no pointer
    // to hover with shows them always, and keyboard focus brings them back
    // for anyone not using one.
    // `quote-block` and `quote-block-control` style nothing: they are there
    // to be reached for from a browser test.
    <div className="group quote-block relative">
      <div className={cn(CONTROLS, "flex items-center gap-1 px-1 py-0.5")}>
        {editable ? handle : null}
        {editable && !block.heading ? (
          // The way to give a block a heading, now that an empty one keeps
          // no line of its own (FF-1649). It lives with the block's other
          // controls, which float — so asking for a heading is the only
          // thing that moves the text, and that is a deliberate act rather
          // than something the pointer does on its way past.
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Add heading"
            onClick={() => setHeadingWanted(true)}
          >
            <Heading1 size={14} />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Expand block"
          onClick={() => {
            setHeldHeight(body.current?.offsetHeight);
            setExpanded(true);
          }}
        >
          <Maximize2 size={14} />
        </Button>
        {editable ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Remove block"
            onClick={onRemove}
          >
            <Trash2 size={14} />
          </Button>
        ) : null}
      </div>

      {/* The heading is part of the document, not a labelled field above it:
          the same type the PDF sets it in, still typed in place. */}
      {editable && (block.heading !== null || headingWanted) ? (
        <Input
          ref={headingBox}
          aria-label="Heading"
          placeholder="Heading"
          value={block.heading ?? ""}
          maxLength={500}
          // No ring, no box, nothing that says "field": a heading being
          // typed shows the caret, the way the text under it does.
          className={cn(
            HEADING_STYLES,
            "h-auto border-0 bg-transparent p-0 focus-visible:ring-0",
          )}
          onChange={(event) =>
            onChange({ heading: event.target.value || null })
          }
          // Asked for and then left empty: the line goes again rather than
          // staying as a band of space above a block with no title
          // (FF-1649).
          onBlur={() => setHeadingWanted(false)}
        />
      ) : block.heading ? (
        <h3 className={HEADING_STYLES}>{block.heading}</h3>
      ) : null}

      <div ref={body}>
        {expanded ? (
          <div style={{ height: heldHeight }} />
        ) : (
          renderEditor(cn(editable && "min-h-[1.5rem]", TEXT_STYLES))
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
