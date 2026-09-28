import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/App";
import { start } from "@/core/app";
import { captureGlobalErrors } from "@/core/log";
import { locale } from "@/i18n";
import { setTheme } from "@/lib/theme";

captureGlobalErrors();
document.documentElement.lang = locale;
// Follow the system theme until settings load, so there is no light flash.
setTheme("system");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The core runs outside React — StrictMode's double effects must not start it twice.
void start();
