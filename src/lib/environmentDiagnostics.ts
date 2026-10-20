/**
 * Diagnostics for "why can't these two devices connect?":
 *  - logEnvironment(context): internet / network / interface / permission snapshot
 *  - startEnvironmentWatcher(): app-state transitions (a system permission dialog pauses the
 *    app), permission changes between checks, live network changes, and native service logs.
 */
import { AppState } from 'react-native';
import {
  getEnvironmentSnapshot,
  isTransferServiceAvailable,
  onTransferServiceLog,
  startNetworkWatch,
} from 'transfer-service';
import { diffPermissions, formatEnvironment, permissionSignature } from './environmentText';
import { logError, logInfo, logWarn } from './logger';

const MIN_GAP_MS = 2000;
const lastLoggedAt: Record<string, number> = {};
let lastPermissionSig: string | null = null;

function emit(level: 'info' | 'warn' | 'error', tag: string, message: string) {
  if (level === 'error') logError(tag, message);
  else if (level === 'warn') logWarn(tag, message);
  else logInfo(tag, message);
}

/** Log a full snapshot. Safe to call often; the same context is rate-limited. */
export async function logEnvironment(context: string): Promise<void> {
  const now = Date.now();
  if (now - (lastLoggedAt[context] ?? 0) < MIN_GAP_MS) return;
  lastLoggedAt[context] = now;

  const snap = await getEnvironmentSnapshot();
  if (!snap) {
    logWarn('env', `env[${context}] snapshot unavailable (native module missing in this build)`);
    return;
  }
  lastPermissionSig = permissionSignature(snap);
  for (const line of formatEnvironment(context, snap)) {
    emit(line.level, 'env', line.message);
  }
}

async function checkPermissionChange(): Promise<void> {
  const snap = await getEnvironmentSnapshot();
  if (!snap) return;
  const sig = permissionSignature(snap);
  if (lastPermissionSig !== null && sig !== lastPermissionSig) {
    const { added, removed } = diffPermissions(lastPermissionSig, snap);
    logWarn(
      'env',
      `permissions changed while app was away: granted+[${added.join(',')}] revoked-[${removed.join(',')}]`
    );
  }
  lastPermissionSig = sig;
}

/** Call once at app start. Returns a cleanup function. */
export function startEnvironmentWatcher(): () => void {
  logInfo('env', `native transfer-service module available=${isTransferServiceAvailable()}`);
  void startNetworkWatch();
  void getEnvironmentSnapshot().then((s) => {
    if (s) lastPermissionSig = permissionSignature(s);
  });

  const unsubNative = onTransferServiceLog((level, message) => {
    if (message.startsWith('net:')) emit(level, 'net', message.slice(4).trim());
    else emit(level, 'foreground', `native: ${message}`);
  });

  let prev = AppState.currentState;
  const sub = AppState.addEventListener('change', (next) => {
    logInfo('app', `app state: ${prev} -> ${next}`);
    prev = next;
    if (next === 'active') void checkPermissionChange();
  });

  return () => {
    unsubNative();
    sub.remove();
  };
}
