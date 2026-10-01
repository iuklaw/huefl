// The HueFL bulb (assets/huefl-on.svg), inline so it scales with its box.
// Each instance gets its own gradient id: two logos on screen (title bar and
// About) must not share one.

import { useId } from "react";

export function HueflLogo({ className, ...props }: React.SVGProps<SVGSVGElement>) {
  const gradient = `hf-glass-${useId()}`;
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
      {...props}
    >
      <defs>
        <linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1="3.5" y1="9.5" x2="12.5" y2="1.5">
          <stop offset="0" stopColor="#2ED4F0" />
          <stop offset="0.38" stopColor="#8A5CFF" />
          <stop offset="0.68" stopColor="#FF5CA8" />
          <stop offset="1" stopColor="#FFB224" />
        </linearGradient>
      </defs>
      <path
        d="M 10 9.33 c .13 -.67 .47 -1.13 1 -1.67 .67 -.6 1 -1.47 1 -2.33 A 4 4 0 0 0 4 5.33 c 0 .67 .13 1.47 1 2.33 .47 .47 .87 1 1 1.67"
        stroke={`url(#${gradient})`}
      />
      <path d="M 6 12 h 4" stroke="#8E97A6" />
      <path d="M 6.7 14.7 h 2.6" stroke="#8E97A6" />
    </svg>
  );
}
