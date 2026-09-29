// Opens the one schedule editor (mounted in App) from anywhere: a room card's
// clock menu, the Schedules screen.

import { useSyncExternalStore } from "react";
import type { Automation, Trigger } from "@/hue/schedules";

export type EditorRequest = {
  roomId?: string;
  existing?: Automation;
  /** Which tab to start on. */
  kind?: Trigger["kind"];
};

let request: EditorRequest | null = null;
const listeners = new Set<() => void>();

function set(next: EditorRequest | null): void {
  request = next;
  for (const listener of listeners) listener();
}

export const openScheduleEditor = (next: EditorRequest = {}) => set(next);
export const closeScheduleEditor = () => set(null);

export function useEditorRequest(): EditorRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => request,
  );
}
