"use client";

interface BubbleMenuButtonProps {
  action: () => void;
  isActive: boolean;
  children: React.ReactNode;
  className?: string;
}

export function BubbleMenuButton({
  action,
  isActive,
  children,
  className,
}: BubbleMenuButtonProps) {
  return (
    <button
      type="button"
      onClick={action}
      className={`px-2.5 py-1.5 text-[11px] transition-colors ${className} ${
        // Both surfaces sit on the background itself, so an active button has
        // to be tinted rather than lifted to white.
        isActive
          ? "bg-accent text-accent-foreground"
          : "bg-transparent hover:bg-muted"
      }`}
    >
      {children}
    </button>
  );
}
