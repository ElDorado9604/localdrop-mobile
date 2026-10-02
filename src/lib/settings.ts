/**
 * App settings persisted in AsyncStorage.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_CACHE_COPY = 'localdrop_cache_copy_small_files';

/** Max size eligible for optional full-file cache copy on send (200 MB). */
export const CACHE_COPY_MAX_BYTES = 200 * 1024 * 1024;

/**
 * When true: if native content:// open fails for a file ≤ 200 MB,
 * copy once into app cache and stream from there, then delete.
 * When false: never full-file cache; stream only (or fail with a clear error).
 * Default: true (better success rate on strict OEMs / Downloads picks).
 */
export async function getCacheCopySmallFiles(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(KEY_CACHE_COPY);
    if (v === null) return true;
    return v === '1' || v === 'true';
  } catch {
    return true;
  }
}

export async function setCacheCopySmallFiles(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_CACHE_COPY, enabled ? '1' : '0');
  } catch {
    /* */
  }
}
