import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Settings from the Tauri template: a fixed port (devUrl in tauri.conf.json)
// and no screen clearing, so Rust logs are not swallowed.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/_electrobun/**"] },
  },
  build: {
    // WebKitGTK 2.4x on Ubuntu 22.04 handles ES2022 just fine.
    target: "es2022",
    outDir: "dist",
  },
});
