/**
 * Phase 1 storage: one public folder only (system Files app).
 * User picks a parent (e.g. Downloads); we prefer a LocalDrop subfolder.
 * No second copy in app-private Documents.
 */

import { Platform, Alert } from 'react-native';
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

export async function getSaveDirectoryUri(): Promise<string | null> {
  return AsyncStorage.getItem(SAVE_DIR_KEY);
}

export async function getSaveDirectoryLabel(): Promise<string> {
  const label = await AsyncStorage.getItem(SAVE_LABEL_KEY);
  return label || FOLDER_NAME;
}

export async function hasSaveDirectory(): Promise<boolean> {
  const uri = await getSaveDirectoryUri();
  return !!uri;
}

/**
 * Ask user to pick a parent folder (e.g. Downloads).
 * Tries to create LocalDrop inside it; falls back to the selected folder.
 * Call only when NOT in an active transfer.
 */
export async function setupPublicSaveFolder(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    // iOS: use app documents (visible in Files with UIFileSharingEnabled)
    const dir =
      (FileSystem.documentDirectory || '') + FOLDER_NAME + '/';
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
    await AsyncStorage.setItem(SAVE_DIR_KEY, dir);
    await AsyncStorage.setItem(SAVE_LABEL_KEY, FOLDER_NAME);
    return true;
  }

  try {
    const perms = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!perms.granted || !perms.directoryUri) return false;

    let targetUri = perms.directoryUri;
    let label = FOLDER_NAME;

    // Prefer a LocalDrop subfolder under the parent the user chose
    try {
      const sub = await FileSystem.StorageAccessFramework.makeDirectoryAsync(
        perms.directoryUri,
        FOLDER_NAME
      );
      if (sub) {
        targetUri = sub;
        label = FOLDER_NAME;
      }
    } catch {
      // Parent may already contain LocalDrop or SAF may not allow mkdir — use parent
      label = 'Selected folder';
    }

    await AsyncStorage.setItem(SAVE_DIR_KEY, targetUri);
    await AsyncStorage.setItem(SAVE_LABEL_KEY, label);
    return true;
  } catch {
    return false;
  }
}

export async function clearSaveDirectory() {
  await AsyncStorage.multiRemove([SAVE_DIR_KEY, SAVE_LABEL_KEY]);
}

/** @deprecated use hasSaveDirectory */
export async function hasPublicLocalDropFolder(): Promise<boolean> {
  return hasSaveDirectory();
}

/** @deprecated use setupPublicSaveFolder */
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

/** Ensure folder is configured; show alert and return false if user must set it. */
export async function ensureSaveFolderOrPrompt(): Promise<boolean> {
  if (await hasSaveDirectory()) return true;
  return false;
}

/**
 * Write received file ONLY to the public save folder (no internal duplicate).
 * Throws if folder not configured.
 */
export async function saveReceivedFile(
  fileName: string,
  base64: string,
  mime?: string,
  sizeHint?: number
): Promise<{ path: string; displayPath: string; id: string }> {
  const dirUri = await getSaveDirectoryUri();
  if (!dirUri) {
    throw new Error('Save folder not set. Open Home and choose a LocalDrop folder first.');
  }

  const name = safeFileName(fileName);
  const mimeType = mime || 'application/octet-stream';
  const id = randomId();
  const label = await getSaveDirectoryLabel();

  let finalPath: string;

  if (Platform.OS === 'android' && dirUri.startsWith('content://')) {
    // SAF public folder
    finalPath = await FileSystem.StorageAccessFramework.createFileAsync(
      dirUri,
      name,
      mimeType
    );
    await FileSystem.writeAsStringAsync(finalPath, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });
  } else {
    // file:// (iOS documents or similar)
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

/** Called on app start — does not create private folder; only validates config. */
export async function initLocalDropStorage(): Promise<void> {
  // No-op for private dir. Folder is user-chosen.
}

/** Legacy helpers kept so older screens compile during transition. */
export function getAppLocalDropDir(): string {
  return (FileSystem.documentDirectory || '') + FOLDER_NAME + '/';
}

export async function ensureAppLocalDropDir(): Promise<string> {
  // Phase 1: do not use internal folder for receives.
  // Return empty marker; saveReceivedFile requires public dir.
  const uri = await getSaveDirectoryUri();
  if (uri) return uri;
  return getAppLocalDropDir();
}
