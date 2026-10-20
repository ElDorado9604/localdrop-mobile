import { requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export type TransferServiceAction = 'cancel' | 'timeout' | 'tick';

type Subscription = { remove(): void };

type TransferServiceNative = {
  start(title: string, text: string): Promise<boolean>;
  update(title: string, text: string, subText: string | null, progress: number): Promise<void>;
  stop(): Promise<void>;
  isRunning(): Promise<boolean>;
  getEnvironment(): Promise<string>;
  startNetworkWatch(): Promise<void>;
  showResult(title: string, text: string, success: boolean): Promise<void>;
  isIgnoringBatteryOptimizations(): Promise<boolean>;
  requestIgnoreBatteryOptimizations(): Promise<boolean>;
  addListener(
    eventName: 'onAction',
    listener: (event: { action: string }) => void
  ): Subscription;
  addListener(
    eventName: 'onLog',
    listener: (event: { level: string; message: string }) => void
  ): Subscription;
};

export type TransferServiceLogLevel = 'info' | 'warn' | 'error';

let native: TransferServiceNative | null = null;

function getNative(): TransferServiceNative | null {
  if (Platform.OS !== 'android') return null;
  if (native) return native;
  try {
    native = requireNativeModule<TransferServiceNative>('TransferService');
    return native;
  } catch {
    return null;
  }
}

/** False on iOS, Expo Go and APKs built before this module existed. */
export function isTransferServiceAvailable(): boolean {
  return getNative() != null;
}

/** Start the foreground service. Resolves false if Android refused or the module is missing. */
export async function startTransferService(title: string, text: string): Promise<boolean> {
  const mod = getNative();
  if (!mod) return false;
  try {
    return await mod.start(title, text);
  } catch {
    return false;
  }
}

/** progress 0..100, or -1 for an indeterminate bar. */
export async function updateTransferService(
  title: string,
  text: string,
  subText: string | null,
  progress: number
): Promise<void> {
  const mod = getNative();
  if (!mod) return;
  try {
    await mod.update(title, text, subText, progress);
  } catch {
    /* notification updates are best effort */
  }
}

export async function stopTransferService(): Promise<void> {
  const mod = getNative();
  if (!mod) return;
  try {
    await mod.stop();
  } catch {
    /* ignore */
  }
}

export async function showTransferResult(
  title: string,
  text: string,
  success: boolean
): Promise<void> {
  const mod = getNative();
  if (!mod) return;
  try {
    await mod.showResult(title, text, success);
  } catch {
    /* ignore */
  }
}

export async function isIgnoringBatteryOptimizations(): Promise<boolean> {
  const mod = getNative();
  if (!mod) return true;
  try {
    return await mod.isIgnoringBatteryOptimizations();
  } catch {
    return true;
  }
}

export async function requestIgnoreBatteryOptimizations(): Promise<boolean> {
  const mod = getNative();
  if (!mod) return false;
  try {
    return await mod.requestIgnoreBatteryOptimizations();
  } catch {
    return false;
  }
}

/** Notification "Cancel" button and the Android 15 dataSync time-limit callback. */
export function onTransferServiceAction(
  listener: (action: TransferServiceAction) => void
): () => void {
  const mod = getNative();
  if (!mod) return () => {};
  try {
    const sub = mod.addListener('onAction', (e) => {
      if (e.action === 'cancel' || e.action === 'timeout' || e.action === 'tick') {
        listener(e.action);
      }
    });
    return () => sub.remove();
  } catch {
    return () => {};
  }
}

export type EnvironmentNetwork = {
  transports: string[];
  internet: boolean;
  validated: boolean;
  active: boolean;
  iface: string;
  addrs: string[];
};

export type EnvironmentSnapshot = {
  sdk: number;
  device: string;
  batteryExempt?: boolean;
  powerSave?: boolean;
  notificationsEnabled?: boolean;
  airplane?: boolean;
  wifiEnabled?: boolean;
  wifiLinkMbps?: number;
  wifiRssi?: number;
  wifiFreqMhz?: number;
  networks: EnvironmentNetwork[];
  interfaces: { name: string; ipv4: string[] }[];
  permissions: { granted: string[]; denied: string[] };
  networkError?: string;
  interfaceError?: string;
  permissionError?: string;
};

/** Network / interface / permission / power snapshot for the Diagnostics log. */
export async function getEnvironmentSnapshot(): Promise<EnvironmentSnapshot | null> {
  const mod = getNative();
  if (!mod) return null;
  try {
    return JSON.parse(await mod.getEnvironment()) as EnvironmentSnapshot;
  } catch {
    return null;
  }
}

/** Start logging network changes (Wi-Fi/cellular/hotspot appearing, changing, lost). */
export async function startNetworkWatch(): Promise<void> {
  const mod = getNative();
  if (!mod) return;
  try {
    await mod.startNetworkWatch();
  } catch {
    /* ignore */
  }
}

/** Log lines produced inside the native service (start/stop, locks, refusals, timeouts). */
export function onTransferServiceLog(
  listener: (level: TransferServiceLogLevel, message: string) => void
): () => void {
  const mod = getNative();
  if (!mod) return () => {};
  try {
    const sub = mod.addListener('onLog', (e) => {
      const level: TransferServiceLogLevel =
        e.level === 'error' || e.level === 'warn' ? e.level : 'info';
      listener(level, e.message);
    });
    return () => sub.remove();
  } catch {
    return () => {};
  }
}

export default {
  isAvailable: isTransferServiceAvailable,
  start: startTransferService,
  update: updateTransferService,
  stop: stopTransferService,
  showResult: showTransferResult,
  isIgnoringBatteryOptimizations,
  requestIgnoreBatteryOptimizations,
  onAction: onTransferServiceAction,
  onLog: onTransferServiceLog,
  getEnvironmentSnapshot,
  startNetworkWatch,
};
