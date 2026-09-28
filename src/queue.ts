// Command queue for the bridge.
//
// The Hue bridge has real rate limits: about 10 commands per second for a
// single light and about 1 per second for a group. A brightness slider produces
// far more than that, so commands are coalesced: for each resource we keep only
// the latest state and send it no more often than every `minIntervalMs`.
//
// `isBusy(key)` tells whether a resource has a command waiting or in flight —
// the UI shows "Syncing…" from that — and `onChange` fires whenever it may
// have changed.

type Payload = Record<string, unknown>;

type Pending = {
  payload: Payload;
  send: (payload: Payload) => Promise<unknown>;
};

export class CommandQueue {
  private readonly pending = new Map<string, Pending>();
  private readonly inFlight = new Set<string>();
  private readonly lastSent = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly minIntervalMs: { light: number; group: number } = {
      light: 100,
      group: 1000,
    },
    private readonly onError: (error: unknown, key: string, payload: Payload) => void = () => {},
    private readonly onChange: () => void = () => {},
  ) {}

  isBusy(key: string): boolean {
    return this.pending.has(key) || this.inFlight.has(key);
  }

  /** `kind` selects the rate limit; `key` is usually `${kind}:${id}`. */
  enqueue(
    kind: "light" | "group",
    key: string,
    payload: Payload,
    send: (payload: Payload) => Promise<unknown>,
  ): void {
    const existing = this.pending.get(key);
    // A shallow merge is enough: {on}, {dimming} and {color_temperature} are disjoint.
    this.pending.set(key, {
      payload: existing ? { ...existing.payload, ...payload } : payload,
      send,
    });
    this.schedule(kind, key);
    this.onChange();
  }

  private schedule(kind: "light" | "group", key: string): void {
    if (this.timer) return;
    const interval = this.minIntervalMs[kind];
    const elapsed = Date.now() - (this.lastSent.get(key) ?? 0);
    const delay = Math.max(0, interval - elapsed);

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  private async flush(): Promise<void> {
    const entries = [...this.pending.entries()];
    this.pending.clear();

    for (const [key] of entries) this.inFlight.add(key);

    for (const [key, { payload, send }] of entries) {
      this.lastSent.set(key, Date.now());
      try {
        await send(payload);
      } catch (error) {
        this.onError(error, key, payload);
      } finally {
        this.inFlight.delete(key);
        this.onChange();
      }
    }

    if (this.pending.size > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, 100);
    }
  }
}
