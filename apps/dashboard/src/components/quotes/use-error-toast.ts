"use client";

import { useToast } from "@midday/ui/use-toast";

/** A refused change, said the way the rest of the quote screens say it. */
export function useErrorToast() {
  const { toast } = useToast();
  return (title: string) => (error: { message: string }) =>
    toast({
      duration: 6000,
      variant: "error",
      title,
      description: error.message,
    });
}
