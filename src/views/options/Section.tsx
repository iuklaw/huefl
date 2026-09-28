import type { ReactNode } from "react";

/** A titled block within an Options tab. */
export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2.5">
      <div>
        <h2 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {title}
        </h2>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}
