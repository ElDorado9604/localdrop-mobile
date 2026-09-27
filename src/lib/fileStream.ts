/**
 * Memory-safe chunked file I/O for LocalDrop.
 * Sender: stream from content:// / file:// (no full cache copy).
 * Receiver: stream directly into SAF / destination (no full temp cache copy).
 */

import * as FileSystemLegacy from 'expo-file-system/legacy';
import { File, FileMode } from 'expo-file-system';
import { Platform } from 'react-native';
import { CHUNK_SIZE } from './transferProtocol';

const READ_CHUNK = CHUNK_SIZE;

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  // Chunk to avoid call-stack / string limits
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/**
 * Stream a file in binary chunks. Constant memory.
 * Works with file:// and content:// URIs — no full-file cache copy required.
 */
export async function streamFileChunks(
  uri: string,
  fileSize: number,
  onChunk: (chunk: ArrayBuffer, offset: number, index: number) => Promise<void>,
  signal?: { cancelled: boolean }
): Promise<void> {
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
          await onChunk(
            data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
            offset,
            index
          );
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
    // Fall through
  }

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

async function deleteUri(uri: string) {
  try {
    await FileSystemLegacy.deleteAsync(uri, { idempotent: true });
  } catch {
    /* SAF delete may fail on some providers — ignore */
  }
}

/**
 * Stream binary chunks directly into the destination (SAF / file).
 * Avoids a full second copy in app cache — receiver needs ~file size free, not 2×.
 */
export async function createDirectReceivedWriter(
  fileName: string,
  mime: string | undefined,
  _sizeHint: number,
  getSaveDirectoryUri: () => Promise<string | null>,
  getSaveDirectoryLabel: () => Promise<string>
): Promise<ReceivedFileWriter> {
  const dirUri = await getSaveDirectoryUri();
  if (!dirUri) {
    throw new Error('Save folder not set. Open Home and choose a folder first.');
  }

  const safeName = fileName.replace(/[/\\?%*:|"<>]/g, '_').trim().slice(0, 180) || 'file';
  const mimeType = mime || 'application/octet-stream';
  const label = await getSaveDirectoryLabel();
  const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

  let targetUri: string;
  let isSaf = false;

  if (Platform.OS === 'android' && dirUri.startsWith('content://')) {
    targetUri = await FileSystemLegacy.StorageAccessFramework.createFileAsync(
      dirUri,
      safeName,
      mimeType
    );
    isSaf = true;
  } else {
    const destDir = dirUri.endsWith('/') ? dirUri : dirUri + '/';
    await FileSystemLegacy.makeDirectoryAsync(destDir, { intermediates: true }).catch(() => {});
    targetUri = destDir + safeName;
    try {
      const info = await FileSystemLegacy.getInfoAsync(targetUri);
      if (info.exists) {
        const dot = safeName.lastIndexOf('.');
        const stem = dot > 0 ? safeName.slice(0, dot) : safeName;
        const ext = dot > 0 ? safeName.slice(dot) : '';
        targetUri = `${destDir}${stem}_${Date.now()}${ext}`;
      }
    } catch {
      /* */
    }
    // Create empty file so handle/append paths work
    await FileSystemLegacy.writeAsStringAsync(targetUri, '', {
      encoding: FileSystemLegacy.EncodingType.UTF8,
    });
  }

  let written = 0;
  let aborted = false;
  let handle: any = null;

  // Prefer FileHandle write directly on destination URI
  try {
    const file = new File(targetUri);
    if (typeof file.open === 'function') {
      handle = file.open(FileMode.ReadWrite);
      handle.offset = 0;
    }
  } catch {
    handle = null;
  }

  // For SAF without FileHandle: accumulate small base64 appends via rewrite is unsafe.
  // Use legacy write only for the first chunk path with position if available;
  // otherwise keep a rolling base64 string only under a hard size limit and fail large.
  // Better fallback: write each chunk with writeAsStringAsync when written===0 (create),
  // then for subsequent chunks use a temp staging ONLY if handle missing.
  let fallbackTemp: string | null = null;
  let fallbackHandle: any = null;

  if (!handle) {
    // Staging only as last resort (still streaming — not full-file in RAM).
    // Prefer cache only if we cannot open destination for write.
    const cacheDir = FileSystemLegacy.cacheDirectory || FileSystemLegacy.documentDirectory || '';
    fallbackTemp = `${cacheDir}localdrop_stage_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await FileSystemLegacy.writeAsStringAsync(fallbackTemp, '', {
      encoding: FileSystemLegacy.EncodingType.UTF8,
    });
    try {
      const f = new File(fallbackTemp);
      if (typeof f.open === 'function') {
        fallbackHandle = f.open(FileMode.ReadWrite);
        fallbackHandle.offset = 0;
      }
    } catch {
      fallbackHandle = null;
    }
  }

  return {
    async writeChunk(chunk: ArrayBuffer) {
      if (aborted) return;
      const bytes = new Uint8Array(chunk);

      if (handle) {
        await handle.writeBytes(bytes);
        handle.offset = (handle.offset ?? 0) + bytes.byteLength;
        written += bytes.byteLength;
        return;
      }

      if (fallbackHandle) {
        await fallbackHandle.writeBytes(bytes);
        fallbackHandle.offset = (fallbackHandle.offset ?? 0) + bytes.byteLength;
        written += bytes.byteLength;
        return;
      }

      // Last-resort Base64 append to staging (small files only)
      if (written + bytes.byteLength > 80 * 1024 * 1024) {
        throw new Error(
          'Large-file receive requires modern FileHandle. Rebuild the app with latest Expo SDK.'
        );
      }
      if (!fallbackTemp) throw new Error('No write target');
      const b64 = arrayBufferToBase64(chunk);
      const existing = await FileSystemLegacy.readAsStringAsync(fallbackTemp, {
        encoding: FileSystemLegacy.EncodingType.Base64,
      }).catch(() => '');
      await FileSystemLegacy.writeAsStringAsync(fallbackTemp, existing + b64, {
        encoding: FileSystemLegacy.EncodingType.Base64,
      });
      written += bytes.byteLength;
    },

    async finish() {
      if (aborted) throw new Error('Writer aborted');

      try {
        handle?.close?.();
      } catch {
        /* */
      }
      try {
        fallbackHandle?.close?.();
      } catch {
        /* */
      }

      // If we staged to temp, copy once into destination then delete temp
      if (fallbackTemp) {
        try {
          if (isSaf) {
            // Overwrite SAF file content via copy
            await FileSystemLegacy.copyAsync({ from: fallbackTemp, to: targetUri });
          } else {
            await FileSystemLegacy.copyAsync({ from: fallbackTemp, to: targetUri });
          }
        } finally {
          await deleteUri(fallbackTemp);
          fallbackTemp = null;
        }
      }

      return {
        path: targetUri,
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
      try {
        fallbackHandle?.close?.();
      } catch {
        /* */
      }
      if (fallbackTemp) {
        await deleteUri(fallbackTemp);
        fallbackTemp = null;
      }
      // Remove incomplete destination so we don't leave 0-byte / partial junk
      await deleteUri(targetUri);
    },
  };
}

/** @deprecated Prefer createDirectReceivedWriter */
export async function createReceivedFileWriter(
  fileName: string,
  mime: string | undefined,
  sizeHint: number,
  _saveReceivedFileFn: (
    name: string,
    base64: string,
    mime?: string,
    sizeHint?: number
  ) => Promise<{ path: string; displayPath: string; id: string }>,
  getSaveDirectoryUri: () => Promise<string | null>,
  getSaveDirectoryLabel: () => Promise<string>
): Promise<ReceivedFileWriter> {
  return createDirectReceivedWriter(
    fileName,
    mime,
    sizeHint,
    getSaveDirectoryUri,
    getSaveDirectoryLabel
  );
}
