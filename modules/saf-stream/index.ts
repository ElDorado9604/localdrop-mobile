import { NativeModulesProxy, requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

type SafStreamNative = {
  open(documentUri: string): Promise<string>;
  write(streamId: string, data: Uint8Array): Promise<number>;
  writeBase64(streamId: string, base64: string): Promise<number>;
  close(streamId: string): Promise<void>;
  abort(streamId: string, documentUri?: string | null): Promise<void>;
};

let native: SafStreamNative | null = null;

function getNative(): SafStreamNative | null {
  if (Platform.OS !== 'android') return null;
  if (native) return native;
  try {
    native = requireNativeModule<SafStreamNative>('SafStream');
    return native;
  } catch {
    try {
      // Fallback for older proxy shape
      const mod = (NativeModulesProxy as any)?.SafStream;
      if (mod) {
        native = mod as SafStreamNative;
        return native;
      }
    } catch {
      /* */
    }
    return null;
  }
}

export function isSafStreamAvailable(): boolean {
  return getNative() != null;
}

export async function openSafStream(documentUri: string): Promise<string> {
  const mod = getNative();
  if (!mod) throw new Error('SafStream native module is not available. Rebuild the Android APK.');
  return mod.open(documentUri);
}

export async function writeSafStream(streamId: string, data: ArrayBuffer | Uint8Array): Promise<number> {
  const mod = getNative();
  if (!mod) throw new Error('SafStream native module is not available');
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return mod.write(streamId, bytes);
}

export async function writeSafStreamBase64(streamId: string, base64: string): Promise<number> {
  const mod = getNative();
  if (!mod) throw new Error('SafStream native module is not available');
  return mod.writeBase64(streamId, base64);
}

export async function closeSafStream(streamId: string): Promise<void> {
  const mod = getNative();
  if (!mod) return;
  await mod.close(streamId);
}

export async function abortSafStream(streamId: string, documentUri?: string | null): Promise<void> {
  const mod = getNative();
  if (!mod) return;
  await mod.abort(streamId, documentUri ?? null);
}

export default {
  isAvailable: isSafStreamAvailable,
  open: openSafStream,
  write: writeSafStream,
  writeBase64: writeSafStreamBase64,
  close: closeSafStream,
  abort: abortSafStream,
};
