import { useSyncExternalStore } from "react";
import { getSyncState, subscribeSync, type SyncState } from "@/core/sync";

export function useSyncState(): SyncState {
  return useSyncExternalStore(subscribeSync, getSyncState);
}
