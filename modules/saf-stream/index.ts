import { NativeModulesProxy, requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

type SafStreamNative = {
  open(documentUri: string): Promise<string>;
  write(streamId: string, data: Uint8Array): Promise<number>;
  writeBase64(streamId: string, base64: string): Promise<number>;
  close(streamId: string): Promise<void>;
  abort(streamId: string, documentUri?: string | null): Promise<void>;
  openInput(documentUri: string): Promise<string>;
  readInputBase64(streamId: string, maxBytes: number): Promise<string>;
  closeInput(streamId: string): Promise<void>;
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
  let offset = 0;
  let total = 0;

  while (offset < bytes.length) {
    const remaining = bytes.length - offset;
    const slice = bytes.subarray(offset, offset + Math.min(remaining, 256 * 1024));
    const written = await mod.write(streamId, slice);
    if (!Number.isFinite(written) || written <= 0) {
      throw new Error(`Partial SAF write failed: wrote ${total} of ${bytes.length} bytes`);
    }
    offset += written;
    total += written;
  }

  if (total !== bytes.length) {
    throw new Error(`Partial SAF write: wrote ${total} of ${bytes.length} bytes`);
  }

  return total;
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

/** Open content:// (or other) URI for sequential read. */
export async function openSafInputStream(documentUri: string): Promise<string> {
  const mod = getNative();
  if (!mod?.openInput) {
    throw new Error('SafStream input is not available. Rebuild the Android APK.');
  }
  return mod.openInput(documentUri);
}

/** Read up to maxBytes; empty string means EOF. */
export async function readSafInputStreamBase64(
  streamId: string,
  maxBytes: number
): Promise<string> {
  const mod = getNative();
  if (!mod?.readInputBase64) {
    throw new Error('SafStream input is not available');
  }
  return mod.readInputBase64(streamId, maxBytes);
}

export async function closeSafInputStream(streamId: string): Promise<void> {
  const mod = getNative();
  if (!mod?.closeInput) return;
  await mod.closeInput(streamId);
}

export default {
  isAvailable: isSafStreamAvailable,
  open: openSafStream,
  write: writeSafStream,
  writeBase64: writeSafStreamBase64,
  close: closeSafStream,
  abort: abortSafStream,
  openInput: openSafInputStream,
  readInputBase64: readSafInputStreamBase64,
  closeInput: closeSafInputStream,
};
