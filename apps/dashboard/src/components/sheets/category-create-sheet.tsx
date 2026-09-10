"use client";

import { Button } from "@midday/ui/button";
import { Icons } from "@midday/ui/icons";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@midday/ui/sheet";
import { useCategoryParams } from "@/hooks/use-category-params";
import { CategoryForm } from "../forms/category-form";

export function CategoryCreateSheet() {
  const { setParams, createCategory } = useCategoryParams();

  const isOpen = Boolean(createCategory);

  return (
    <Sheet open={isOpen} onOpenChange={() => setParams(null)}>
      <SheetContent>
        <SheetHeader className="mb-6 flex justify-between items-center flex-row">
          <SheetTitle className="text-xl font-normal">
            Create Category
          </SheetTitle>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setParams(null)}
            className="p-0 m-0 size-auto hover:bg-transparent"
          >
            <Icons.Close className="size-5" />
          </Button>
        </SheetHeader>

        <CategoryForm />
      </SheetContent>
    </Sheet>
  );
}
