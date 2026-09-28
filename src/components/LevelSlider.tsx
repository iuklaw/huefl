// A slider for brightness or color temperature.
//
// While dragging it shows its own value: the core publishes optimistic state
// and bridge events on every step, and following those would make the thumb
// jitter. After release it goes back to following `value`. Commands are sent
// on every step — CommandQueue coalesces them to the bridge's rate limits.

import { useState, type ReactNode } from "react";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

type Props = {
  value: number;
  min?: number;
  max?: number;
  label: string;
  icon?: ReactNode;
  /** Warm-to-cool gradient track instead of a filled range. */
  variant?: "level" | "temperature";
  disabled?: boolean;
  onChange: (value: number) => void;
  /** Called once when the user releases the thumb — for logging the final value. */
  onCommit?: (value: number) => void;
  className?: string;
};

export function LevelSlider({
  value,
  min = 1,
  max = 100,
  label,
  icon,
  variant = "level",
  disabled,
  onChange,
  onCommit,
  className,
}: Props) {
  const [dragValue, setDragValue] = useState<number | null>(null);

  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      {icon && <span className="text-muted-foreground [&_svg]:size-3.5">{icon}</span>}
      <Slider
        aria-label={label}
        min={min}
        max={max}
        step={1}
        disabled={disabled}
        value={[dragValue ?? clamp(value, min, max)]}
        onValueChange={([next]) => {
          if (next === undefined) return;
          setDragValue(next);
          onChange(next);
        }}
        onValueCommit={([final]) => {
          setDragValue(null);
          if (final !== undefined) onCommit?.(final);
        }}
        className={cn(
          "[&_[data-slot=slider-thumb]]:size-4 [&_[data-slot=slider-thumb]]:border-2 [&_[data-slot=slider-thumb]]:border-primary",
          "[&_[data-slot=slider-track]]:h-1.5",
          variant === "temperature" &&
            "[&_[data-slot=slider-range]]:bg-transparent [&_[data-slot=slider-track]]:bg-gradient-to-r [&_[data-slot=slider-track]]:from-sky-200 [&_[data-slot=slider-track]]:via-amber-50 [&_[data-slot=slider-track]]:to-orange-400",
        )}
      />
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
