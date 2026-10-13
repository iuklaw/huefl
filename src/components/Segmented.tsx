// A row of mutually exclusive choices, like iOS's segmented control: the
// chosen one raised on a muted track.

import { cn } from "@/lib/utils";

export function Segmented<T extends string>({
  options,
  value,
  disabled,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div
      className="grid gap-1 rounded-lg bg-muted p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      role="radiogroup"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-md py-1 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
            value === option.value
              ? "bg-background font-medium shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
