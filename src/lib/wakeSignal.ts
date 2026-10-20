/**
 * Waiting without relying on JS timers.
 *
 * React Native on Android pauses setTimeout/setInterval while the app is in the background, so
 * `await new Promise(r => setTimeout(r, 40))` never finishes and the transfer stalls until the
 * user reopens the app. Events from native code (data-channel messages, and the 200 ms "tick"
 * from the foreground service) do keep arriving, so waits are woken by those instead and the
 * timer is only a fallback for the foreground.
 */

export class WakeSignal {
  private listeners = new Set<() => void>();

  /** Run `fn` once on the next notify(). Returns an unsubscribe function. */
  once(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  notify(): void {
    if (this.listeners.size === 0) return;
    const pending = [...this.listeners];
    this.listeners.clear();
    for (const fn of pending) fn();
  }
}

/** Fired every ~200 ms by the native foreground service while a transfer runs. */
export const backgroundTick = new WakeSignal();

/** Fired when the peer reports write progress (an "ack"). */
export const ackSignal = new WakeSignal();

/**
 * Resolves on the next background tick, on any of `signals`, or after `fallbackMs`
 * (timer fallback; does not fire while the app is hidden).
 */
export function waitForWake(fallbackMs: number, ...signals: WakeSignal[]): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const unsubs: Array<() => void> = [];
    const timer = setTimeout(() => finish(), fallbackMs);
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const u of unsubs) u();
      resolve();
    }
    for (const s of [backgroundTick, ...signals]) unsubs.push(s.once(finish));
  });
}
