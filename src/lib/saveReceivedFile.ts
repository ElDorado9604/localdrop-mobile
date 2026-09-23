/**
 * Save received files into a LocalDrop folder on the device.
 * - Always writes to app Documents/LocalDrop (persistent).
 * - On Android, if the user once picked a public folder via SAF, also writes there
 *   so files show up in the system Files app under that folder.
 */

import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SAF_DIR_KEY = 'localdrop_saf_directory_uri';
const APP_FOLDER = 'LocalDrop';

function safeFileName(name: string): string {
  const base = name.replace(/[/\\?%*:|"<>]/g, '_').trim() || 'file';
  return base.slice(0, 180);
}

export function getAppLocalDropDir(): string {
  return (FileSystem.documentDirectory || '') + APP_FOLDER + '/';
}

export async function ensureAppLocalDropDir(): Promise<string> {
  const dir = getAppLocalDropDir();
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
  return dir;
}

/** One-time: let user pick/create a public folder (e.g. Downloads/LocalDrop). */
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

/**
 * Write base64 file contents to LocalDrop.
 * Returns app path + short display label for UI.
 */
export async function saveReceivedFile(
  fileName: string,
  base64: string,
  mime?: string
): Promise<{ path: string; displayPath: string }> {
  const name = safeFileName(fileName);
  const mimeType = mime || 'application/octet-stream';

  // 1) Always save into app Documents/LocalDrop
  const dir = await ensureAppLocalDropDir();
  let path = dir + name;

  // Avoid overwrite collisions
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

  // 2) Android: also copy into user-picked public folder if configured
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
      return {
        path: publicUri,
        displayPath: `${APP_FOLDER}/${name}`,
      };
    } catch {
      // Fall back to app path label
    }
  }

  return {
    path,
    displayPath: `${APP_FOLDER}/${name}`,
  };
}
