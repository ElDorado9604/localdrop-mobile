/**
 * Keeps an active transfer alive while the user is in other apps:
 *  - starts an Android foreground service with an ongoing progress notification,
 *  - pushes progress to that notification about once a second,
 *  - handles the notification's Cancel button,
 *  - re-starts the service when the app returns to the foreground after Android's
 *    dataSync time limit (Android 15+) ended it,
 *  - posts a "complete / failed" notification if the transfer ends while the app is hidden.
 *
 * It never shows a permission dialog: notification / battery permissions are requested once in
 * the first-launch setup (and can be changed in Settings). Without them the service still runs.
 *
 * Call it from a transfer screen with the screen's live state. The transfer itself is untouched.
 */
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import {
  onTransferServiceAction,
  showTransferResult,
  startTransferService,
  stopTransferService,
  updateTransferService,
} from 'transfer-service';
import {
  buildProgressNotification,
  buildResultNotification,
  type NotificationRole,
} from './transferNotificationText';
import { logInfo, logWarn } from './logger';
import { backgroundTick } from './wakeSignal';

const TAG = 'foreground';
const UPDATE_INTERVAL_MS = 1000;

export type TransferForegroundParams = {
  /** The screen's phase string; the service runs while this is 'transferring'. */
  phase: string;
  role: NotificationRole;
  peerName?: string;
  bytesDone: number;
  bytesTotal: number;
  speed: number;
  error?: string | null;
  /** Called when the user taps Cancel in the notification. */
  onCancel: () => void;
};

export function useTransferForeground(params: TransferForegroundParams): void {
  const latest = useRef(params);
  latest.current = params;

  const active = params.phase === 'transferring';
  const serviceOn = useRef(false);
  const starting = useRef(false);
  const prevPhase = useRef(params.phase);
  const lastPushAt = useRef(0);
  const hiddenPushLogged = useRef(false);
  const hiddenTickLogged = useRef(false);

  // Push the latest progress to the notification, at most once per second.
  // NOTE: JS timers (setInterval) are paused by React Native on Android while the app is in the
  // background, so this is also called from the progress changes themselves (data arriving).
  const pushProgress = (force = false) => {
    if (!serviceOn.current) return;
    const now = Date.now();
    if (!force && now - lastPushAt.current < UPDATE_INTERVAL_MS) return;
    lastPushAt.current = now;
    const n = buildProgressNotification(latest.current);
    if (AppState.currentState !== 'active' && !hiddenPushLogged.current) {
      hiddenPushLogged.current = true;
      logInfo(TAG, `first progress update while app hidden: ${n.progress}%`);
    }
    void updateTransferService(n.title, n.text, n.subText ?? null, n.progress);
  };

  // Service lifetime == transferring phase.
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    hiddenPushLogged.current = false;
    hiddenTickLogged.current = false;

    (async () => {
      starting.current = true;
      try {
        const first = buildProgressNotification(latest.current);
        const ok = await startTransferService(first.title, first.text);
        if (disposed) {
          await stopTransferService();
          return;
        }
        serviceOn.current = ok;
        logInfo(TAG, ok ? 'foreground service started' : 'foreground service NOT started');
        if (ok) {
          pushProgress(true);
        }
      } finally {
        starting.current = false;
      }
    })();

    // Foreground fallback only; does not fire while the app is hidden.
    const timer = setInterval(() => pushProgress(), UPDATE_INTERVAL_MS);

    return () => {
      disposed = true;
      clearInterval(timer);
      if (serviceOn.current) logInfo(TAG, 'foreground service stopped');
      serviceOn.current = false;
      void stopTransferService();
    };
  }, [active]);

  // Event-driven updates: runs whenever progress changes, including while the app is hidden.
  useEffect(() => {
    if (active) pushProgress();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, params.bytesDone, params.speed]);

  // Notification Cancel button + Android 15 time-limit callback.
  useEffect(() => {
    return onTransferServiceAction((action) => {
      if (action === 'tick') {
        // Native heartbeat: keeps waits and notification updates moving while JS timers are
        // paused (app in background).
        if (AppState.currentState !== 'active' && !hiddenTickLogged.current) {
          hiddenTickLogged.current = true;
          logInfo(TAG, 'native tick reaching JS while app hidden (background waits are woken)');
        }
        backgroundTick.notify();
        pushProgress();
      } else if (action === 'cancel') {
        logWarn(TAG, 'cancel pressed in notification');
        latest.current.onCancel();
      } else if (action === 'timeout') {
        logWarn(TAG, 'Android dataSync time limit reached; service stopped until app is reopened');
        serviceOn.current = false;
      }
    });
  }, []);

  // Back in the foreground while still transferring but the service is not running
  // (time limit hit, or the first start was refused): start it again.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (latest.current.phase !== 'transferring') return;
      if (serviceOn.current || starting.current) return;
      starting.current = true;
      const n = buildProgressNotification(latest.current);
      void startTransferService(n.title, n.text)
        .then((ok) => {
          serviceOn.current = ok;
          logInfo(TAG, ok ? 'foreground service restarted' : 'foreground service restart refused');
        })
        .finally(() => {
          starting.current = false;
        });
    });
    return () => sub.remove();
  }, []);

  // Transfer ended while the app was hidden: leave a result notification.
  useEffect(() => {
    const prev = prevPhase.current;
    prevPhase.current = params.phase;
    if (prev !== 'transferring') return;
    if (params.phase !== 'completed' && params.phase !== 'failed') return;
    if (AppState.currentState === 'active') return;

    logInfo(TAG, `transfer ended while app hidden (${params.phase}); posting result notification`);
    const r = buildResultNotification({
      role: latest.current.role,
      peerName: latest.current.peerName,
      outcome: params.phase,
      bytesTotal: latest.current.bytesTotal,
      error: latest.current.error,
    });
    void showTransferResult(r.title, r.text, params.phase === 'completed');
  }, [params.phase]);
}
