/**
 * Memory-safe chunked file I/O for LocalDrop.
 * Sender: stream from content:// / file:// (no full cache copy).
 * Receiver: stage to app cache temp, then move into SAF (reliable on Android).
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
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/**
 * Stream a file in binary chunks. Constant memory.
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
  /** Bytes actually written to the staging file */
  getWrittenBytes: () => number;
};

async function deleteUri(uri: string) {
  try {
    await FileSystemLegacy.deleteAsync(uri, { idempotent: true });
  } catch {
    /* */
  }
}

/**
 * Reliable receive writer:
 * 1) Stream all chunks into a real file:// temp in app cache (FileHandle).
 * 2) On finish, create SAF document and copy temp → content:// URI.
 * Avoids broken direct SAF FileHandle and malformed copy destinations.
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

  const cacheDir = FileSystemLegacy.cacheDirectory || FileSystemLegacy.documentDirectory || '';
  if (!cacheDir) {
    throw new Error('No cache directory available on this device.');
  }

  // Always stage to a real file:// path first
  const tempUri = `${cacheDir}localdrop_recv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeName}`;
  await FileSystemLegacy.writeAsStringAsync(tempUri, '', {
    encoding: FileSystemLegacy.EncodingType.UTF8,
  });

  let written = 0;
  let aborted = false;
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
    getWrittenBytes: () => written,

    async writeChunk(chunk: ArrayBuffer) {
      if (aborted) return;
      const bytes = new Uint8Array(chunk);

      if (handle) {
        await handle.writeBytes(bytes);
        handle.offset = (handle.offset ?? 0) + bytes.byteLength;
        written += bytes.byteLength;
        return;
      }

      // Base64 append fallback for tiny files only
      if (written + bytes.byteLength > 80 * 1024 * 1024) {
        throw new Error(
          'Large-file receive requires modern FileHandle. Rebuild the app with latest Expo SDK.'
        );
      }
      const b64 = arrayBufferToBase64(chunk);
      const existing = await FileSystemLegacy.readAsStringAsync(tempUri, {
        encoding: FileSystemLegacy.EncodingType.Base64,
      }).catch(() => '');
      await FileSystemLegacy.writeAsStringAsync(tempUri, existing + b64, {
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
      handle = null;

      // Verify temp has data
      try {
        const info = await FileSystemLegacy.getInfoAsync(tempUri);
        if (!info.exists || ((info as any).size ?? written) === 0) {
          await deleteUri(tempUri);
          throw new Error('Received file is empty — transfer may have failed.');
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('empty')) throw e;
      }

      let finalPath: string;

      if (Platform.OS === 'android' && dirUri.startsWith('content://')) {
        // Create the destination document in the user-picked folder
        let safFileUri: string;
        try {
          safFileUri = await FileSystemLegacy.StorageAccessFramework.createFileAsync(
            dirUri,
            safeName,
            mimeType
          );
        } catch (e) {
          await deleteUri(tempUri);
          const msg = e instanceof Error ? e.message : String(e);
          if (/isn't writable|not writable|permission|SAF/i.test(msg)) {
            throw new Error(
              'Save folder is not writable. Open Home and choose the LocalDrop folder again.'
            );
          }
          throw e;
        }

        // Copy file:// temp → content:// document (Expo-supported)
        try {
          await FileSystemLegacy.copyAsync({ from: tempUri, to: safFileUri });
        } catch (copyErr) {
          // Fallback: base64 write into SAF document (works for moderate sizes)
          try {
            const b64 = await FileSystemLegacy.readAsStringAsync(tempUri, {
              encoding: FileSystemLegacy.EncodingType.Base64,
            });
            await FileSystemLegacy.writeAsStringAsync(safFileUri, b64, {
              encoding: FileSystemLegacy.EncodingType.Base64,
            });
          } catch {
            await deleteUri(safFileUri);
            await deleteUri(tempUri);
            const msg = copyErr instanceof Error ? copyErr.message : String(copyErr);
            throw new Error(
              `Could not save into LocalDrop folder. Re-select the folder on Home. (${msg})`
            );
          }
        }

        await deleteUri(tempUri);
        finalPath = safFileUri;
      } else {
        // file:// destination (iOS / non-SAF)
        const destDir = dirUri.endsWith('/') ? dirUri : dirUri + '/';
        await FileSystemLegacy.makeDirectoryAsync(destDir, { intermediates: true }).catch(
          () => {}
        );
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
        await deleteUri(tempUri);
        finalPath = dest;
      }

      return {
        path: finalPath,
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
      handle = null;
      await deleteUri(tempUri);
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
