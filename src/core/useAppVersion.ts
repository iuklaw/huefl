import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

// The app version from tauri.conf.json — one source for About and the footer.
// Fetched once per session; later components get the cached value.
let cached: string | null = null;
let pending: Promise<string> | null = null;

export function useAppVersion(): string | null {
  const [version, setVersion] = useState(cached);

  useEffect(() => {
    if (cached) return;
    let alive = true;
    pending ??= getVersion().then((v) => (cached = v));
    void pending.then((v) => alive && setVersion(v));
    return () => {
      alive = false;
    };
  }, []);

  return version;
}
