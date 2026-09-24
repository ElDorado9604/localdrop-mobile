/**
 * Public save folder only (system Files app).
 * User picks or creates the folder themselves — we never create a subfolder.
 * No second copy in app-private Documents.
 */

import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SAVE_DIR_KEY = 'localdrop_public_save_dir_uri';
const SAVE_LABEL_KEY = 'localdrop_public_save_label';
const RECEIVED_INDEX_KEY = 'localdrop_received_index_v1';
const FOLDER_NAME = 'LocalDrop';

export type ReceivedFileRecord = {
  id: string;
  name: string;
  path: string;
  displayPath: string;
  size: number;
  mime?: string;
  receivedAt: number;
};

function safeFileName(name: string): string {
  const base = name.replace(/[/\\?%*:|"<>]/g, '_').trim() || 'file';
  return base.slice(0, 180);
}

function randomId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Turn a SAF tree URI into a readable path when possible.
 * e.g. content://…/tree/primary%3ADownload%2FLocalDrop
 *   → /storage/emulated/0/Download/LocalDrop
 */
export function humanPathFromSafUri(uri: string): string {
  try {
    const treeMatch = uri.match(/\/tree\/([^?]+)/);
    if (treeMatch) {
      let decoded = decodeURIComponent(treeMatch[1]);
      if (decoded.startsWith('primary:')) {
        return '/storage/emulated/0/' + decoded.slice('primary:'.length);
      }
      if (decoded.startsWith('raw:')) {
        return decoded.slice(4);
      }
      const sd = decoded.match(/^([0-9A-Fa-f-]+):(.+)$/);
      if (sd) {
        return `/storage/${sd[1]}/${sd[2]}`;
      }
      return decoded;
    }
    const docMatch = uri.match(/\/document\/([^?]+)/);
    if (docMatch) {
      let decoded = decodeURIComponent(docMatch[1]);
      if (decoded.startsWith('primary:')) {
        return '/storage/emulated/0/' + decoded.slice('primary:'.length);
      }
      return decoded;
    }
  } catch {
    /* */
  }
  return 'Selected folder';
}

export async function getSaveDirectoryUri(): Promise<string | null> {
  return AsyncStorage.getItem(SAVE_DIR_KEY);
}

export async function getSaveDirectoryLabel(): Promise<string> {
  let label = await AsyncStorage.getItem(SAVE_LABEL_KEY);
  const uri = await getSaveDirectoryUri();

  // Upgrade old generic labels from URI when possible
  if (uri && (!label || label === 'Selected folder' || label === FOLDER_NAME)) {
    const human = humanPathFromSafUri(uri);
    if (human && human !== 'Selected folder') {
      label = human;
      await AsyncStorage.setItem(SAVE_LABEL_KEY, human).catch(() => {});
    }
  }

  return label || FOLDER_NAME;
}

export async function hasSaveDirectory(): Promise<boolean> {
  const uri = await getSaveDirectoryUri();
  return !!uri;
}

export async function setupPublicSaveFolder(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    const dir = (FileSystem.documentDirectory || '') + FOLDER_NAME + '/';
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
    await AsyncStorage.setItem(SAVE_DIR_KEY, dir);
    await AsyncStorage.setItem(SAVE_LABEL_KEY, FOLDER_NAME);
    return true;
  }

  try {
    const perms = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!perms.granted || !perms.directoryUri) return false;

    const label = humanPathFromSafUri(perms.directoryUri);
    await AsyncStorage.setItem(SAVE_DIR_KEY, perms.directoryUri);
    await AsyncStorage.setItem(SAVE_LABEL_KEY, label);
    return true;
  } catch {
    return false;
  }
}

export async function clearSaveDirectory() {
  await AsyncStorage.multiRemove([SAVE_DIR_KEY, SAVE_LABEL_KEY]);
}

/** @deprecated */
export async function hasPublicLocalDropFolder(): Promise<boolean> {
  return hasSaveDirectory();
}

/** @deprecated */
export async function requestPublicLocalDropFolder(): Promise<boolean> {
  return setupPublicSaveFolder();
}

export async function clearPublicLocalDropFolder() {
  return clearSaveDirectory();
}

async function readIndex(): Promise<ReceivedFileRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(RECEIVED_INDEX_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as ReceivedFileRecord[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function writeIndex(list: ReceivedFileRecord[]) {
  await AsyncStorage.setItem(RECEIVED_INDEX_KEY, JSON.stringify(list));
}

export async function addToReceivedIndex(rec: ReceivedFileRecord) {
  const list = await readIndex();
  list.unshift(rec);
  await writeIndex(list.slice(0, 500));
}

export async function listReceivedFiles(): Promise<ReceivedFileRecord[]> {
  const list = await readIndex();
  return list.sort((a, b) => b.receivedAt - a.receivedAt);
}

export async function removeFromReceivedIndex(id: string) {
  const list = await readIndex();
  await writeIndex(list.filter((x) => x.id !== id));
}

export async function ensureSaveFolderOrPrompt(): Promise<boolean> {
  if (await hasSaveDirectory()) return true;
  return false;
}

/**
 * Resolve content:// to a file:// cache path so Expo Sharing works.
 */
export async function resolveShareableUri(
  path: string,
  fileName: string
): Promise<string> {
  if (path.startsWith('file://')) return path;

  if (path.startsWith('content://')) {
    const cacheDir = FileSystem.cacheDirectory || FileSystem.documentDirectory || '';
    const dest = cacheDir + 'share_' + Date.now() + '_' + safeFileName(fileName);
    await FileSystem.copyAsync({ from: path, to: dest });
    return dest;
  }

  if (path.startsWith('/')) return 'file://' + path;
  return path;
}

export async function saveReceivedFile(
  fileName: string,
  base64: string,
  mime?: string,
  sizeHint?: number
): Promise<{ path: string; displayPath: string; id: string }> {
  const dirUri = await getSaveDirectoryUri();
  if (!dirUri) {
    throw new Error('Save folder not set. Open Home and choose a folder first.');
  }

  const name = safeFileName(fileName);
  const mimeType = mime || 'application/octet-stream';
  const id = randomId();
  const label = await getSaveDirectoryLabel();

  let finalPath: string;

  if (Platform.OS === 'android' && dirUri.startsWith('content://')) {
    finalPath = await FileSystem.StorageAccessFramework.createFileAsync(
      dirUri,
      name,
      mimeType
    );
    await FileSystem.writeAsStringAsync(finalPath, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });
  } else {
    await FileSystem.makeDirectoryAsync(dirUri, { intermediates: true }).catch(() => {});
    let path = dirUri.endsWith('/') ? dirUri + name : dirUri + '/' + name;
    try {
      const info = await FileSystem.getInfoAsync(path);
      if (info.exists) {
        const dot = name.lastIndexOf('.');
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        path = `${dirUri.endsWith('/') ? dirUri : dirUri + '/'}${stem}_${Date.now()}${ext}`;
      }
    } catch {
      /* */
    }
    await FileSystem.writeAsStringAsync(path, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    finalPath = path;
  }

  const approxSize =
    typeof sizeHint === 'number' && sizeHint > 0
      ? sizeHint
      : Math.floor((base64.length * 3) / 4);

  const displayPath = `${label}/${name}`;

  await addToReceivedIndex({
    id,
    name,
    path: finalPath,
    displayPath,
    size: approxSize,
    mime: mimeType,
    receivedAt: Date.now(),
  });

  return { path: finalPath, displayPath, id };
}

export async function initLocalDropStorage(): Promise<void> {}

export function getAppLocalDropDir(): string {
  return (FileSystem.documentDirectory || '') + FOLDER_NAME + '/';
}

export async function ensureAppLocalDropDir(): Promise<string> {
  const uri = await getSaveDirectoryUri();
  if (uri) return uri;
  return getAppLocalDropDir();
}
