"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
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
import { Button } from "@midday/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@midday/ui/card";
import { cn } from "@midday/ui/cn";
import { CurrencyInput } from "@midday/ui/currency-input";
import { Input } from "@midday/ui/input";
import { useToast } from "@midday/ui/use-toast";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { GripVertical } from "lucide-react";
import { useEffect, useState } from "react";
import { useTRPC } from "@/trpc/client";

type WorkType = RouterOutputs["workTypes"]["list"][number];

function useWorkTypeMutationOptions() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return {
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: trpc.workTypes.list.queryKey(),
      }),
    onError: (error: { message: string }) =>
      toast({
        duration: 6000,
        variant: "error",
        title: "That did not work",
        description: error.message,
      }),
  };
}

/**
 * Settings → Quotes → Work types (FF-1607): the team's list, each with its
 * default hourly rate. Drag to reorder; archiving takes a type out of the
 * pickers and keeps it for the quotes that already use it.
 */
export function WorkTypesSettings() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const options = useWorkTypeMutationOptions();
  const listKey = trpc.workTypes.list.queryKey({ includeArchived: true });
  const { data } = useSuspenseQuery(
    trpc.workTypes.list.queryOptions({ includeArchived: true }),
  );

  const active = data.filter((w) => !w.archivedAt);
  const archived = data.filter((w) => w.archivedAt);

  // One scope, so two quick drags are saved in the order they were made.
  const reorder = useMutation({
    ...trpc.workTypes.reorder.mutationOptions(options),
    scope: { id: "work-types-reorder" },
  });

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const onDragEnd = ({ active: dragged, over }: DragEndEvent) => {
    if (!over || dragged.id === over.id) return;
    const from = active.findIndex((w) => w.id === dragged.id);
    const to = active.findIndex((w) => w.id === over.id);
    const moved = arrayMove(active, from, to);

    // Shown moved at once; the invalidation afterwards brings back the truth.
    void queryClient.cancelQueries({ queryKey: listKey });
    queryClient.setQueryData(listKey, [...moved, ...archived]);
    reorder.mutate({ ids: moved.map((w) => w.id) });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Work types</CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        {active.length > 0 ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
          >
            <SortableContext
              items={active.map((w) => w.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="divide-y divide-border border border-border">
                {active.map((workType) => (
                  <WorkTypeRow key={workType.id} workType={workType} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        ) : null}

        <AddWorkType />

        {archived.length > 0 ? (
          <div>
            <div className="mb-2 text-sm text-[#878787]">Archived</div>
            <div className="divide-y divide-border border border-border">
              {archived.map((workType) => (
                <ArchivedRow key={workType.id} workType={workType} />
              ))}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function WorkTypeRow({ workType }: { workType: WorkType }) {
  const trpc = useTRPC();
  const options = useWorkTypeMutationOptions();
  const update = useMutation(trpc.workTypes.update.mutationOptions(options));
  const archive = useMutation(trpc.workTypes.archive.mutationOptions(options));

  const [name, setName] = useState(workType.name);
  const [rate, setRate] = useState<number | undefined>(workType.hourlyRate);

  // Follow the server when it changes, e.g. an edit made in another tab.
  useEffect(() => setName(workType.name), [workType.name]);
  useEffect(() => setRate(workType.hourlyRate), [workType.hourlyRate]);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: workType.id });

  const saveName = () => {
    const next = name.trim();
    if (!next) {
      setName(workType.name);
      return;
    }
    if (next !== workType.name) update.mutate({ id: workType.id, name: next });
  };

  const saveRate = () => {
    if (rate === undefined) {
      setRate(workType.hourlyRate);
      return;
    }
    if (rate !== workType.hourlyRate) {
      update.mutate({ id: workType.id, hourlyRate: rate });
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "flex items-center gap-2 bg-background px-2 py-2",
        isDragging && "relative z-10 border border-border",
      )}
    >
      <button
        type="button"
        aria-label={`Move ${workType.name}`}
        className="cursor-grab text-muted-foreground active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={14} />
      </button>
      <Input
        aria-label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={saveName}
        maxLength={100}
        className="flex-1"
      />
      <CurrencyInput
        aria-label="Hourly rate"
        value={rate ?? ""}
        onValueChange={(values) => setRate(values.floatValue)}
        onBlur={saveRate}
        decimalScale={2}
        allowNegative={false}
        suffix={` ${workType.currency}/h`}
        className="w-[160px] text-right"
      />
      <Button
        variant="ghost"
        size="sm"
        disabled={archive.isPending}
        onClick={() => archive.mutate({ id: workType.id })}
      >
        Archive
      </Button>
    </div>
  );
}

function AddWorkType() {
  const trpc = useTRPC();
  const options = useWorkTypeMutationOptions();
  const [name, setName] = useState("");
  const [rate, setRate] = useState<number | undefined>();

  const create = useMutation(
    trpc.workTypes.create.mutationOptions({
      ...options,
      onSuccess: () => {
        setName("");
        setRate(undefined);
      },
    }),
  );

  const canAdd = name.trim().length > 0 && rate !== undefined;

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (canAdd) create.mutate({ name: name.trim(), hourlyRate: rate });
      }}
    >
      <Input
        aria-label="Name"
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={100}
        className="flex-1"
      />
      <CurrencyInput
        aria-label="Hourly rate"
        placeholder="Hourly rate"
        value={rate ?? ""}
        onValueChange={(values) => setRate(values.floatValue)}
        decimalScale={2}
        allowNegative={false}
        className="w-[160px] text-right"
      />
      <Button
        type="submit"
        variant="outline"
        disabled={!canAdd || create.isPending}
      >
        Add
      </Button>
    </form>
  );
}

function ArchivedRow({ workType }: { workType: WorkType }) {
  const trpc = useTRPC();
  const options = useWorkTypeMutationOptions();
  const restore = useMutation(trpc.workTypes.restore.mutationOptions(options));

  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 text-sm text-[#878787]">
      <span className="truncate">{workType.name}</span>
      <Button
        variant="ghost"
        size="sm"
        disabled={restore.isPending}
        onClick={() => restore.mutate({ id: workType.id })}
      >
        Restore
      </Button>
    </div>
  );
}
