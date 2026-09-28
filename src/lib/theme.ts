// Applies the theme preference as the `dark` class on <html>, which is what
// the shadcn/Tailwind tokens in index.css key off. "system" follows the OS
// setting live.

import type { ThemePreference } from "@/types";

const media = window.matchMedia("(prefers-color-scheme: dark)");
let current: ThemePreference = "system";

function apply(): void {
  const dark = current === "dark" || (current === "system" && media.matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

media.addEventListener("change", apply);

export function setTheme(preference: ThemePreference): void {
  current = preference;
  apply();
}
