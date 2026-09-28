// Ready-made presets for the "Popular" list. Colors are hand-picked in the
// spirit of popular Color Hunt palettes; white presets use a color temperature
// instead, like the Hue app's Relax / Read / Concentrate scenes.
// Names are translated through i18n keys `palette.<id>`.

import type { Palette } from "@/types";

export const POPULAR_PALETTES: Palette[] = [
  { id: "spring", brightness: 80, colors: ["#FFB7C5", "#B8E986", "#FFF1A8", "#A0E7E5"] },
  { id: "summer", brightness: 100, colors: ["#FFB347", "#FF6F61", "#FFD93D", "#4ECDC4"] },
  { id: "autumn", brightness: 60, colors: ["#D35400", "#E67E22", "#C0392B", "#F1C40F"] },
  { id: "winter", brightness: 70, colors: ["#A9D6E5", "#E0FBFC", "#89C2D9", "#C3B1E1"] },
  { id: "calm", brightness: 40, colors: ["#6A8EAE", "#9BD1E5", "#B8B8FF", "#F0E6EF"] },
  { id: "energy", brightness: 100, colors: ["#FF3E6C", "#FFD23F", "#3EC1D3", "#FF9A00"] },
  { id: "sunset", brightness: 60, colors: ["#FF5E5B", "#FF9E6D", "#FFD166", "#8E5572"] },
  { id: "ocean", brightness: 70, colors: ["#0077B6", "#00B4D8", "#90E0EF", "#48CAE4"] },
  { id: "forest", brightness: 60, colors: ["#2D6A4F", "#52B788", "#95D5B2", "#D8F3DC"] },
  { id: "romance", brightness: 40, colors: ["#FF4D6D", "#C9184A", "#FF8FA3", "#A4133C"] },
  { id: "relax", brightness: 40, mirek: 455 }, // 2200 K
  { id: "read", brightness: 80, mirek: 345 }, // 2900 K
  { id: "concentrate", brightness: 100, mirek: 233 }, // 4300 K
];
