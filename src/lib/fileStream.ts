/**
 * Memory-safe chunked file I/O for LocalDrop.
 * Sender: native ContentResolver InputStream for content:// (no full-file cache by default).
 * Optional: full-file cache copy for ≤200 MB when settings allow and native open fails.
 * Receiver (Android SAF): native ContentResolver OutputStream (200 GB capable).
 * No readAsStringAsync on content:// URIs.
 */

import * as FileSystemLegacy from 'expo-file-system/legacy';
import { File, FileMode } from 'expo-file-system';
import { Platform } from 'react-native';
import { OFFLINE_CHUNK_SIZE } from './transferProtocol';
import {
  isSafStreamAvailable,
  openSafStream,
  writeSafStream,
  closeSafStream,
  abortSafStream,
  openSafInputStream,
  readSafInputStreamBase64,
  closeSafInputStream,
} from 'saf-stream';
import { getCacheCopySmallFiles, CACHE_COPY_MAX_BYTES } from './settings';

const CACHE_STAGE_MAX = 100 * 1024 * 1024; // 100 MB receive-only fallback

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function streamFromFileUri(
  uri: string,
  fileSize: number,
  onChunk: (chunk: ArrayBuffer, offset: number, index: number) => Promise<void>,
  signal: { cancelled: boolean } | undefined,
  readChunk: number
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
          const toRead = Math.min(readChunk, fileSize - offset);
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
    /* fall through */
  }

  if (uri.startsWith('content://')) {
    throw new Error(
      'Cannot read this file from storage. Rebuild the app with the latest native module, then try again.'
    );
  }

  let offset = 0;
  let index = 0;
  while (offset < fileSize) {
    if (signal?.cancelled) throw new Error('Transfer cancelled');
    const length = Math.min(readChunk, fileSize - offset);
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

/**
 * If native content:// open fails and settings allow, copy once into app cache
 * (only for files ≤ CACHE_COPY_MAX_BYTES), stream, then delete the copy.
 */
async function tryCacheCopyAndStream(
  uri: string,
  fileSize: number,
  onChunk: (chunk: ArrayBuffer, offset: number, index: number) => Promise<void>,
  signal: { cancelled: boolean } | undefined,
  readChunk: number
): Promise<boolean> {
  if (fileSize <= 0 || fileSize > CACHE_COPY_MAX_BYTES) return false;
  const allowed = await getCacheCopySmallFiles();
  if (!allowed) return false;

  const cacheDir =
    FileSystemLegacy.cacheDirectory || FileSystemLegacy.documentDirectory || '';
  if (!cacheDir) return false;

  const dest = `${cacheDir}localdrop_send_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    await FileSystemLegacy.copyAsync({ from: uri, to: dest });
  } catch {
    try {
      // Some content:// URIs need StorageAccessFramework-style access via native only
      return false;
    } catch {
      return false;
    }
  }

  try {
    await streamFromFileUri(dest, fileSize, onChunk, signal, readChunk);
    return true;
  } finally {
    try {
      await FileSystemLegacy.deleteAsync(dest, { idempotent: true });
    } catch {
      /* */
    }
  }
}

/**
 * Stream a file in binary chunks. Constant memory when native open works.
 * content:// → native openInputStream (required on Android).
 * On permission failure: optional full-file cache for ≤200 MB if settings allow.
 * file:// → FileHandle / legacy.
 * @param chunkSize defaults to offline 256 KB; pass ONLINE_CHUNK_SIZE (64 KB) for web-compatible online sends
 */
export async function streamFileChunks(
  uri: string,
  fileSize: number,
  onChunk: (chunk: ArrayBuffer, offset: number, index: number) => Promise<void>,
  signal?: { cancelled: boolean },
  chunkSize: number = OFFLINE_CHUNK_SIZE
): Promise<void> {
  const readChunk = Math.max(16 * 1024, chunkSize);

  // ——— Native SAF / ContentResolver input (Android content://) ———
  if (
    Platform.OS === 'android' &&
    uri.startsWith('content://') &&
    isSafStreamAvailable()
  ) {
    let streamId: string | null = null;
    try {
      streamId = await openSafInputStream(uri);
      let offset = 0;
      let index = 0;
      while (offset < fileSize) {
        if (signal?.cancelled) throw new Error('Transfer cancelled');
        const toRead = Math.min(readChunk, fileSize - offset);
        const b64 = await readSafInputStreamBase64(streamId, toRead);
        if (!b64) break;
        const buf = base64ToArrayBuffer(b64);
        if (buf.byteLength === 0) break;
        await onChunk(buf, offset, index);
        offset += buf.byteLength;
        index++;
      }
      if (offset === 0 && fileSize > 0) {
        throw new Error('Could not read file (empty stream). Try picking the file again.');
      }
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isPerm =
        /Permission|denied|SecurityException|obtain access|OPEN_DOCUMENT/i.test(msg);

      if (isPerm) {
        try {
          if (streamId) {
            await closeSafInputStream(streamId);
            streamId = null;
          }
        } catch {
          /* */
        }
        const usedCache = await tryCacheCopyAndStream(
          uri,
          fileSize,
          onChunk,
          signal,
          readChunk
        );
        if (usedCache) return;

        if (fileSize > CACHE_COPY_MAX_BYTES) {
          throw new Error(
            'Cannot read this large file from storage (permission). Re-pick the file, or move it into a folder LocalDrop can access. Full cache copy is not used for files over 200 MB.'
          );
        }
        throw new Error(
          'Cannot read this file (permission). Re-pick it from the system picker. Or enable "Cache copy for small files" in Settings (Home) for files up to 200 MB.'
        );
      }

      throw new Error(
        msg.includes('not available') || msg.includes('Rebuild')
          ? msg
          : `Cannot read this file. ${msg}`
      );
    } finally {
      if (streamId) {
        try {
          await closeSafInputStream(streamId);
        } catch {
          /* */
        }
      }
    }
  }

  await streamFromFileUri(uri, fileSize, onChunk, signal, readChunk);
}

export type ReceivedFileWriter = {
  writeChunk: (chunk: ArrayBuffer) => Promise<void>;
  finish: () => Promise<{ path: string; displayPath: string; id: string }>;
  abort: () => Promise<void>;
  getWrittenBytes: () => number;
};

async function deleteUri(uri: string) {
  try {
    await FileSystemLegacy.deleteAsync(uri, { idempotent: true });
  } catch {
    /* */
  }
}

function openWriteHandle(uri: string): any | null {
  try {
    const file = new File(uri);
    if (typeof file.open === 'function') {
      const handle = file.open(FileMode.ReadWrite);
      handle.offset = 0;
      return handle;
    }
  } catch {
    /* */
  }
  return null;
}

async function createNativeSafWriter(
  dirUri: string,
  safeName: string,
  mimeType: string,
  label: string,
  id: string
): Promise<ReceivedFileWriter> {
  const targetUri = await FileSystemLegacy.StorageAccessFramework.createFileAsync(
    dirUri,
    safeName,
    mimeType
  );

  let streamId: string;
  try {
    streamId = await openSafStream(targetUri);
  } catch (e) {
    await deleteUri(targetUri);
    throw e;
  }

  let written = 0;
  let aborted = false;

  return {
    getWrittenBytes: () => written,

    async writeChunk(chunk: ArrayBuffer) {
      if (aborted) return;
      const n = await writeSafStream(streamId, chunk);
      written += n;
    },

    async finish() {
      if (aborted) throw new Error('Writer aborted');
      await closeSafStream(streamId);
      if (written === 0) {
        await deleteUri(targetUri);
        throw new Error('Received file is empty — transfer may have failed.');
      }
      return {
        path: targetUri,
        displayPath: `${label}/${safeName}`,
        id,
      };
    },

    async abort() {
      aborted = true;
      await abortSafStream(streamId, targetUri);
    },
  };
}

export async function createDirectReceivedWriter(
  fileName: string,
  mime: string | undefined,
  sizeHint: number,
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

  if (
    Platform.OS === 'android' &&
    dirUri.startsWith('content://') &&
    isSafStreamAvailable()
  ) {
    try {
      return await createNativeSafWriter(dirUri, safeName, mimeType, label, id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/isn't writable|not writable|permission|SAF|OutputStream/i.test(msg)) {
        throw new Error(
          'Save folder is not writable. Open Home and choose the LocalDrop folder again.'
        );
      }
      if (sizeHint > CACHE_STAGE_MAX) {
        throw e;
      }
    }
  }

  const allowCacheStage = sizeHint > 0 && sizeHint <= CACHE_STAGE_MAX;
  let targetUri: string;
  let mode: 'direct' | 'cache' = 'direct';
  let tempUri: string | null = null;
  let handle: any = null;
  let written = 0;
  let aborted = false;

  if (Platform.OS === 'android' && dirUri.startsWith('content://')) {
    try {
      targetUri = await FileSystemLegacy.StorageAccessFramework.createFileAsync(
        dirUri,
        safeName,
        mimeType
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/isn't writable|not writable|permission|SAF/i.test(msg)) {
        throw new Error(
          'Save folder is not writable. Open Home and choose the LocalDrop folder again.'
        );
      }
      throw e;
    }

    handle = openWriteHandle(targetUri);
    if (!handle) {
      if (!allowCacheStage) {
        await deleteUri(targetUri);
        throw new Error(
          'Native SAF stream unavailable. Rebuild the Android APK with the latest code.'
        );
      }
      mode = 'cache';
      const cacheDir =
        FileSystemLegacy.cacheDirectory || FileSystemLegacy.documentDirectory || '';
      if (!cacheDir) {
        await deleteUri(targetUri);
        throw new Error('No cache directory available for small-file fallback.');
      }
      tempUri = `${cacheDir}localdrop_recv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await FileSystemLegacy.writeAsStringAsync(tempUri, '', {
        encoding: FileSystemLegacy.EncodingType.UTF8,
      });
      handle = openWriteHandle(tempUri);
      if (!handle) {
        await deleteUri(tempUri);
        await deleteUri(targetUri);
        throw new Error('Could not open a write handle.');
      }
    }
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
    await FileSystemLegacy.writeAsStringAsync(targetUri, '', {
      encoding: FileSystemLegacy.EncodingType.UTF8,
    });
    handle = openWriteHandle(targetUri);
    if (!handle) {
      await deleteUri(targetUri);
      throw new Error('Could not open destination file for writing.');
    }
  }

  return {
    getWrittenBytes: () => written,

    async writeChunk(chunk: ArrayBuffer) {
      if (aborted) return;
      const bytes = new Uint8Array(chunk);
      if (!handle) throw new Error('Write handle closed');
      await handle.writeBytes(bytes);
      handle.offset = (handle.offset ?? 0) + bytes.byteLength;
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

      if (written === 0) {
        if (tempUri) await deleteUri(tempUri);
        await deleteUri(targetUri);
        throw new Error('Received file is empty — transfer may have failed.');
      }

      if (mode === 'cache' && tempUri) {
        try {
          await FileSystemLegacy.copyAsync({ from: tempUri, to: targetUri });
        } catch {
          try {
            const b64 = await FileSystemLegacy.readAsStringAsync(tempUri, {
              encoding: FileSystemLegacy.EncodingType.Base64,
            });
            await FileSystemLegacy.writeAsStringAsync(targetUri, b64, {
              encoding: FileSystemLegacy.EncodingType.Base64,
            });
          } catch {
            await deleteUri(tempUri);
            await deleteUri(targetUri);
            throw new Error(
              'Could not save into LocalDrop folder. Re-select the folder on Home.'
            );
          }
        }
        await deleteUri(tempUri);
        tempUri = null;
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
      handle = null;
      if (tempUri) await deleteUri(tempUri);
      await deleteUri(targetUri);
    },
  };
}

/** @deprecated */
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
