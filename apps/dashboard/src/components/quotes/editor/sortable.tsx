"use client";

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@midday/ui/cn";
import { GripVertical } from "lucide-react";
import { type ReactNode, useId } from "react";

/** A vertical list reordered by dragging a row's handle. */
export function SortableList<T extends { id: string }>({
  items,
  onReorder,
  disabled = false,
  children,
}: {
  items: T[];
  onReorder: (items: T[]) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const sensors = useSensors(
    // A few pixels first, so a click in a row's inputs is not a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // dnd-kit numbers its accessibility ids per render; a stable id keeps the
  // server's HTML and the browser's the same.
  const id = useId();

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = items.findIndex((item) => item.id === active.id);
    const to = items.findIndex((item) => item.id === over.id);
    onReorder(arrayMove(items, from, to));
  };

  return (
    <DndContext
      id={id}
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
    >
      <SortableContext
        items={items.map((item) => item.id)}
        strategy={verticalListSortingStrategy}
        disabled={disabled}
      >
        {children}
      </SortableContext>
    </DndContext>
  );
}

/** A row of a `SortableList`; `children` gets the drag handle to place. */
export function SortableRow({
  id,
  label,
  className,
  children,
}: {
  id: string;
  label: string;
  className?: string;
  children: (handle: ReactNode) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const handle = (
    <button
      type="button"
      aria-label={`Move ${label}`}
      // dnd-kit withholds the listeners on a list that cannot be reordered,
      // and a handle that does nothing should not look like one either.
      disabled={!listeners}
      className="cursor-grab text-muted-foreground active:cursor-grabbing disabled:cursor-default disabled:opacity-30"
      {...attributes}
      {...listeners}
    >
      <GripVertical size={14} />
    </button>
  );

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "bg-background",
        isDragging && "relative z-10 shadow-sm",
        className,
      )}
    >
      {children(handle)}
    </div>
  );
}
