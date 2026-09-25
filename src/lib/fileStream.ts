/**
 * Memory-safe chunked file I/O for LocalDrop.
 * Avoids loading entire files into JS (fixes OOM on multi-GB transfers).
 * Uses modern expo-file-system FileHandle when possible; falls back to
 * legacy position/length Base64 reads for content:// URIs.
 */

import * as FileSystemLegacy from 'expo-file-system/legacy';
import { File, Paths, FileMode } from 'expo-file-system';
import { Platform } from 'react-native';
import { CHUNK_SIZE } from './transferProtocol';

const READ_CHUNK = CHUNK_SIZE; // 64 KB — safe for WebRTC + JS heap

/** Convert small Base64 string → ArrayBuffer without holding huge strings. */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Stream a file in binary chunks. Never loads the whole file into memory.
 * Works with file:// and most content:// URIs.
 */
export async function streamFileChunks(
  uri: string,
  fileSize: number,
  onChunk: (chunk: ArrayBuffer, offset: number, index: number) => Promise<void>,
  signal?: { cancelled: boolean }
): Promise<void> {
  // Prefer modern FileHandle (supports >2GB offsets correctly)
  try {
    const file = new File(uri);
    if (typeof file.open === 'function') {
      const handle = file.open(FileMode.ReadOnly);
      try {
        handle.offset = 0;
        let offset = 0;
        let index = 0;
        while (offset < fileSize) {
          if (signal?.cancelled) throw new Error('Transfer cancelled');
          const toRead = Math.min(READ_CHUNK, fileSize - offset);
          const data = await handle.readBytes(toRead);
          if (!data || data.byteLength === 0) break;
          await onChunk(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), offset, index);
          offset += data.byteLength;
          index++;
          handle.offset = offset;
        }
        return;
      } finally {
        try {
          handle.close();
        } catch {
          /* */
        }
      }
    }
  } catch {
    // Fall through to legacy path
  }

  // Legacy path: position + length (Base64). Safe for <2GB; may have issues above 2GB on older Android.
  let offset = 0;
  let index = 0;
  while (offset < fileSize) {
    if (signal?.cancelled) throw new Error('Transfer cancelled');
    const length = Math.min(READ_CHUNK, fileSize - offset);
    const b64 = await FileSystemLegacy.readAsStringAsync(uri, {
      encoding: FileSystemLegacy.EncodingType.Base64,
      position: offset,
      length,
    });
    if (!b64) break;
    const buf = base64ToArrayBuffer(b64);
    await onChunk(buf, offset, index);
    offset += buf.byteLength;
    index++;
  }
}

export type ReceivedFileWriter = {
  writeChunk: (chunk: ArrayBuffer) => Promise<void>;
  finish: () => Promise<{ path: string; displayPath: string; id: string }>;
  abort: () => Promise<void>;
};

/**
 * Create a writer that streams binary chunks to a temp cache file,
 * then moves the completed file into the user's public LocalDrop folder.
 * Memory stays constant regardless of file size.
 */
export async function createReceivedFileWriter(
  fileName: string,
  mime: string | undefined,
  sizeHint: number,
  saveReceivedFileFn: (
    name: string,
    base64: string,
    mime?: string,
    sizeHint?: number
  ) => Promise<{ path: string; displayPath: string; id: string }>,
  getSaveDirectoryUri: () => Promise<string | null>,
  getSaveDirectoryLabel: () => Promise<string>
): Promise<ReceivedFileWriter> {
  const safeName = fileName.replace(/[/\\?%*:|"<>]/g, '_').trim().slice(0, 180) || 'file';
  const cacheDir = FileSystemLegacy.cacheDirectory || FileSystemLegacy.documentDirectory || '';
  const tempUri = `${cacheDir}localdrop_tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeName}`;

  // Create empty temp file
  await FileSystemLegacy.writeAsStringAsync(tempUri, '', {
    encoding: FileSystemLegacy.EncodingType.UTF8,
  });

  let written = 0;
  let aborted = false;

  // Prefer modern FileHandle for append-style writes
  let handle: any = null;
  try {
    const file = new File(tempUri);
    if (typeof file.open === 'function') {
      handle = file.open(FileMode.ReadWrite);
      handle.offset = 0;
    }
  } catch {
    handle = null;
  }

  return {
    async writeChunk(chunk: ArrayBuffer) {
      if (aborted) return;
      const bytes = new Uint8Array(chunk);

      if (handle) {
        await handle.writeBytes(bytes);
        handle.offset = (handle.offset ?? 0) + bytes.byteLength;
      } else {
        // Fallback: append via Base64 (only for smaller files; still better than full-file)
        const b64 = btoa(String.fromCharCode(...bytes));
        // Legacy has no true append for binary; we re-read is too expensive.
        // For safety on huge files we rely on modern handle.
        // If we reach here on very large files, fail early.
        if (written + bytes.byteLength > 80 * 1024 * 1024) {
          throw new Error(
            'Large-file write requires modern expo-file-system FileHandle. Please rebuild the app with latest Expo SDK.'
          );
        }
        const existing = await FileSystemLegacy.readAsStringAsync(tempUri, {
          encoding: FileSystemLegacy.EncodingType.Base64,
        }).catch(() => '');
        await FileSystemLegacy.writeAsStringAsync(tempUri, existing + b64, {
          encoding: FileSystemLegacy.EncodingType.Base64,
        });
      }
      written += bytes.byteLength;
    },

    async finish() {
      if (aborted) throw new Error('Writer aborted');
      try {
        handle?.close?.();
      } catch {
        /* */
      }

      // Move temp → public folder using existing save logic.
      // We read the temp file in Base64 only if small; for large we copy via native.
      const dirUri = await getSaveDirectoryUri();
      if (!dirUri) {
        throw new Error('Save folder not set. Open Home and choose a folder first.');
      }

      const label = await getSaveDirectoryLabel();
      const mimeType = mime || 'application/octet-stream';

      if (Platform.OS === 'android' && dirUri.startsWith('content://')) {
        // Create target via SAF, then copy bytes natively
        const targetUri = await FileSystemLegacy.StorageAccessFramework.createFileAsync(
          dirUri,
          safeName,
          mimeType
        );
        await FileSystemLegacy.copyAsync({ from: tempUri, to: targetUri });
        // Clean temp
        await FileSystemLegacy.deleteAsync(tempUri, { idempotent: true }).catch(() => {});

        // Index entry (reuse logic via a minimal record)
        const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
        // Caller will add to index; we return the paths
        return {
          path: targetUri,
          displayPath: `${label}/${safeName}`,
          id,
        };
      }

      // Non-SAF (iOS / file://)
      const destDir = dirUri.endsWith('/') ? dirUri : dirUri + '/';
      let dest = destDir + safeName;
      try {
        const info = await FileSystemLegacy.getInfoAsync(dest);
        if (info.exists) {
          const dot = safeName.lastIndexOf('.');
          const stem = dot > 0 ? safeName.slice(0, dot) : safeName;
          const ext = dot > 0 ? safeName.slice(dot) : '';
          dest = `${destDir}${stem}_${Date.now()}${ext}`;
        }
      } catch {
        /* */
      }
      await FileSystemLegacy.copyAsync({ from: tempUri, to: dest });
      await FileSystemLegacy.deleteAsync(tempUri, { idempotent: true }).catch(() => {});

      const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
      return {
        path: dest,
        displayPath: `${label}/${safeName}`,
        id,
      };
    },

    async abort() {
      aborted = true;
      try {
        handle?.close?.();
      } catch {
        /* */
      }
      await FileSystemLegacy.deleteAsync(tempUri, { idempotent: true }).catch(() => {});
    },
  };
}
