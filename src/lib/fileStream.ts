/**
 * Memory-safe chunked file I/O for LocalDrop.
 * Never loads the whole file into JS memory.
 * Sender can stream from content:// / file:// without copying into app cache.
 */

import * as FileSystemLegacy from 'expo-file-system/legacy';
import { File, FileMode } from 'expo-file-system';
import { Platform } from 'react-native';
import { CHUNK_SIZE } from './transferProtocol';

const READ_CHUNK = CHUNK_SIZE; // matches transfer chunk size (256 KB)

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Stream a file in binary chunks. Constant memory.
 * Works with file:// and content:// (SAF) URIs — no full-file cache copy required.
 */
export async function streamFileChunks(
  uri: string,
  fileSize: number,
  onChunk: (chunk: ArrayBuffer, offset: number, index: number) => Promise<void>,
  signal?: { cancelled: boolean }
): Promise<void> {
  // Prefer modern FileHandle (supports large offsets)
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
    // Fall through to legacy path
  }

  // Legacy: position + length Base64 reads (works on content:// without full copy)
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
 * Stream binary chunks to a temp cache file, then move into public LocalDrop folder.
 * Receiver still needs ~file size free space for the final save.
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
    async writeChunk(chunk: ArrayBuffer) {
      if (aborted) return;
      const bytes = new Uint8Array(chunk);

      if (handle) {
        await handle.writeBytes(bytes);
        handle.offset = (handle.offset ?? 0) + bytes.byteLength;
      } else {
        if (written + bytes.byteLength > 80 * 1024 * 1024) {
          throw new Error(
            'Large-file write requires modern expo-file-system FileHandle. Please rebuild the app.'
          );
        }
        const b64 = btoa(String.fromCharCode(...bytes));
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

      const dirUri = await getSaveDirectoryUri();
      if (!dirUri) {
        throw new Error('Save folder not set. Open Home and choose a folder first.');
      }

      const label = await getSaveDirectoryLabel();
      const mimeType = mime || 'application/octet-stream';

      if (Platform.OS === 'android' && dirUri.startsWith('content://')) {
        const targetUri = await FileSystemLegacy.StorageAccessFramework.createFileAsync(
          dirUri,
          safeName,
          mimeType
        );
        await FileSystemLegacy.copyAsync({ from: tempUri, to: targetUri });
        await FileSystemLegacy.deleteAsync(tempUri, { idempotent: true }).catch(() => {});

        const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
        return {
          path: targetUri,
          displayPath: `${label}/${safeName}`,
          id,
        };
      }

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
