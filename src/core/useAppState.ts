import { useSyncExternalStore } from "react";
import { getState, subscribe } from "./app";
import type { AppState } from "@/types";

/** The core's state as React state — re-renders on every publish. */
export function useAppState(): AppState {
  return useSyncExternalStore(subscribe, getState);
}
