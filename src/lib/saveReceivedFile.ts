/**
 * Save received files into LocalDrop and maintain a received-files index
 * for the home screen list.
 */

import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SAF_DIR_KEY = 'localdrop_saf_directory_uri';
const RECEIVED_INDEX_KEY = 'localdrop_received_index_v1';
const APP_FOLDER = 'LocalDrop';

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

export function getAppLocalDropDir(): string {
  return (FileSystem.documentDirectory || '') + APP_FOLDER + '/';
}

/** Create Documents/LocalDrop if missing. Safe to call often. */
export async function ensureAppLocalDropDir(): Promise<string> {
  const dir = getAppLocalDropDir();
  try {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
  } catch {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
  }
  return dir;
}

/** Call on app start. */
export async function initLocalDropStorage(): Promise<void> {
  await ensureAppLocalDropDir();
}

export async function requestPublicLocalDropFolder(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    const perms = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!perms.granted || !perms.directoryUri) return false;
    await AsyncStorage.setItem(SAF_DIR_KEY, perms.directoryUri);
    return true;
  } catch {
    return false;
  }
}

export async function hasPublicLocalDropFolder(): Promise<boolean> {
  const uri = await AsyncStorage.getItem(SAF_DIR_KEY);
  return !!uri;
}

export async function clearPublicLocalDropFolder() {
  await AsyncStorage.removeItem(SAF_DIR_KEY);
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
  // keep last 500
  await writeIndex(list.slice(0, 500));
}

/** Newest first. */
export async function listReceivedFiles(): Promise<ReceivedFileRecord[]> {
  const list = await readIndex();
  return list.sort((a, b) => b.receivedAt - a.receivedAt);
}

export async function removeFromReceivedIndex(id: string) {
  const list = await readIndex();
  await writeIndex(list.filter((x) => x.id !== id));
}

/**
 * Write base64 to app LocalDrop (+ optional public SAF folder).
 * Always indexes the file for the home “Files Received” list.
 */
export async function saveReceivedFile(
  fileName: string,
  base64: string,
  mime?: string,
  sizeHint?: number
): Promise<{ path: string; displayPath: string; id: string }> {
  const name = safeFileName(fileName);
  const mimeType = mime || 'application/octet-stream';
  const id = randomId();

  const dir = await ensureAppLocalDropDir();
  let path = dir + name;

  try {
    const info = await FileSystem.getInfoAsync(path);
    if (info.exists) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      path = `${dir}${stem}_${Date.now()}${ext}`;
    }
  } catch {
    /* */
  }

  await FileSystem.writeAsStringAsync(path, base64, {
    encoding: FileSystem.EncodingType.Base64,
  });

  let displayPath = `${APP_FOLDER}/${name}`;
  let finalPath = path;

  const safUri = await AsyncStorage.getItem(SAF_DIR_KEY);
  if (Platform.OS === 'android' && safUri) {
    try {
      const publicUri = await FileSystem.StorageAccessFramework.createFileAsync(
        safUri,
        name,
        mimeType
      );
      await FileSystem.writeAsStringAsync(publicUri, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      finalPath = publicUri;
      displayPath = `${APP_FOLDER}/${name}`;
    } catch {
      /* keep app path */
    }
  }

  const approxSize =
    typeof sizeHint === 'number' && sizeHint > 0
      ? sizeHint
      : Math.floor((base64.length * 3) / 4);

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
