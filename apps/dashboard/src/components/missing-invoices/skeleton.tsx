import { Skeleton } from "@midday/ui/skeleton";

export function MissingInvoicesSkeleton() {
  return (
    <div className="flex flex-col gap-6 pb-8">
      <div className="border-b border-border pb-4">
        <Skeleton className="h-7 w-[220px]" />
        <Skeleton className="mt-2 h-4 w-[280px]" />
      </div>

      <div className="flex flex-col gap-4">
        {[...Array(4)].map((_, index) => (
          <div key={index.toString()} className="border border-border">
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <Skeleton className="h-4 w-[160px]" />
                <Skeleton className="mt-2 h-3 w-[110px]" />
              </div>
              <Skeleton className="h-8 w-[130px]" />
            </div>
            <div className="border-t border-border">
              {[...Array(2)].map((__, row) => (
                <div
                  key={row.toString()}
                  className="flex items-center justify-between border-b border-border px-4 py-3 last:border-b-0"
                >
                  <Skeleton className="h-4 w-[240px]" />
                  <Skeleton className="h-4 w-[70px]" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
