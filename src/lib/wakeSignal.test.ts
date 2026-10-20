import { describe, it, expect, vi, afterEach } from 'vitest';
import { WakeSignal, backgroundTick, waitForWake } from './wakeSignal';

afterEach(() => {
  vi.useRealTimers();
});

describe('waitForWake', () => {
  it('resolves on a background tick even if the timer never fires', async () => {
    vi.useFakeTimers(); // timers frozen, like an app in the background
    let resolved = false;
    const p = waitForWake(40).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    backgroundTick.notify();
    await p;
    expect(resolved).toBe(true);
  });

  it('resolves on an extra signal', async () => {
    vi.useFakeTimers();
    const sig = new WakeSignal();
    const p = waitForWake(40, sig);
    sig.notify();
    await p;
  });

  it('falls back to the timer in the foreground', async () => {
    vi.useFakeTimers();
    const p = waitForWake(40);
    vi.advanceTimersByTime(40);
    await p;
  });

  it('does not leak listeners after resolving', async () => {
    vi.useFakeTimers();
    const sig = new WakeSignal();
    const p = waitForWake(40, sig);
    vi.advanceTimersByTime(40);
    await p;
    let called = false;
    sig.once(() => {
      called = true;
    });
    sig.notify();
    expect(called).toBe(true);
  });
});
