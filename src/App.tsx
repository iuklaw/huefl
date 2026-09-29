import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AmbientGradient } from "@/components/AmbientGradient";
import { AppFooter } from "@/components/AppFooter";
import { CloseDialog } from "@/components/CloseDialog";
import { TitleBar } from "@/components/TitleBar";
import { actions, getState } from "@/core/app";
import { log } from "@/core/log";
import { useAppState } from "@/core/useAppState";
import { useSyncState } from "@/core/useSyncState";
import { liveGlow } from "@/lib/color";
import { setTheme } from "@/lib/theme";
import { HomeView } from "@/views/HomeView";
import { OptionsView, type OptionsTab } from "@/views/OptionsView";
import { PairingView } from "@/views/PairingView";
import { SyncView } from "@/views/SyncView";
import { MainTabs, type MainTab } from "@/components/MainTabs";

type View = { name: "home" } | { name: "options"; tab: OptionsTab };

export function App() {
  const state = useAppState();
  const { status: syncStatus, preview } = useSyncState();
  // While sync streams, the background follows the lights live.
  const live = syncStatus.state === "streaming" && preview.length > 0 ? liveGlow(preview) : null;
  const [view, setView] = useState<View>({ name: "home" });
  const [closeOpen, setCloseOpen] = useState(false);
  /** Lights or Sync — the two main views under the title bar. */
  const [mainTab, setMainTab] = useState<MainTab>("lights");
  /** Expanded rooms ("Lights") and lights (color) — kept here so it survives visiting Options.
   *  Room and light ids are UUIDs, so one set holds both. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => setTheme(state.preferences.theme), [state.preferences.theme]);

  // One path for every way of closing: our X button and the window manager
  // (Alt+F4), which Rust turns into a "close-requested" event.
  const requestClose = () => {
    switch (getState().preferences.closeBehavior) {
      case "tray":
        return void actions.hideToTray();
      case "quit":
        return void actions.quit();
      default:
        setCloseOpen(true);
    }
  };

  useEffect(() => {
    const unlisten = [
      listen("close-requested", () => requestClose()),
      listen("open-options", () => setView({ name: "options", tab: "general" })),
      // Tray "Start sync" with nothing to repeat yet: show the Sync tab.
      listen("open-sync", () => {
        setView({ name: "home" });
        setMainTab("sync");
      }),
    ];
    return () => unlisten.forEach((p) => void p.then((off) => off()));
  }, []);

  const openOptions = (tab: OptionsTab = "general") => setView({ name: "options", tab });

  return (
    <div className="relative flex h-full flex-col bg-background">
      <TitleBar onOptions={() => openOptions()} onClose={requestClose} />

      {view.name === "options" ? (
        <OptionsView
          state={state}
          tab={view.tab}
          onTabChange={(tab) => setView({ name: "options", tab })}
          onBack={() => setView({ name: "home" })}
        />
      ) : state.status === "unconfigured" ? (
        <PairingView />
      ) : (
        // One glow behind both main views; the content sits above it.
        <div className="relative flex min-h-0 flex-1 flex-col">
          <AmbientGradient rooms={state.rooms} live={live} />
          <div className="relative z-10 flex min-h-0 flex-1 flex-col">
            <MainTabs value={mainTab} onChange={setMainTab} />
            {mainTab === "sync" ? (
              <SyncView onRepair={() => openOptions("bridge")} />
            ) : (
              <HomeView
                state={state}
                expanded={expanded}
                onExpandedChange={setExpanded}
                onOpenBridgeSettings={() => openOptions("bridge")}
              />
            )}
          </div>
        </div>
      )}

      <AppFooter />

      <CloseDialog
        open={closeOpen}
        onOpenChange={setCloseOpen}
        onChoose={async (choice, remember) => {
          setCloseOpen(false);
          log.info(
            "app",
            "window.close_choice",
            `Close dialog: ${choice}${remember ? " (remembered)" : ""}`,
            {
              choice,
              remember,
            },
          );
          if (remember) await actions.setPreferences({ closeBehavior: choice });
          await (choice === "tray" ? actions.hideToTray() : actions.quit());
        }}
      />
    </div>
  );
}
