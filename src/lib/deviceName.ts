/**
 * Friendly device display name for pairing / transfer screens.
 * Priority: user-saved name → system deviceName → modelName → brand+model → fallback.
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Device from 'expo-device';

const KEY = 'localdrop_display_name';
const MAX_LEN = 40;

/** Auto name from the device (ignores user override). */
export async function getDefaultDeviceName(): Promise<string> {
  try {
    const systemName = Device.deviceName?.trim();
    if (systemName && systemName.length > 1 && systemName.toLowerCase() !== 'device') {
      return systemName.slice(0, MAX_LEN);
    }
  } catch {
    /* */
  }

  try {
    const model = Device.modelName?.trim();
    if (model && model.length > 1) return model.slice(0, MAX_LEN);
  } catch {
    /* */
  }

  try {
    const brand = Device.brand?.trim() || Device.manufacturer?.trim();
    const model = Device.modelName?.trim();
    if (brand && model) return `${brand} ${model}`.slice(0, MAX_LEN);
    if (brand) return brand.slice(0, MAX_LEN);
  } catch {
    /* */
  }

  return Platform.OS === 'ios' ? 'iPhone' : 'Android phone';
}

/** Name shown in rooms / transfers (saved override or default). */
export async function getDisplayName(): Promise<string> {
  try {
    const saved = await AsyncStorage.getItem(KEY);
    if (saved && saved.trim()) return saved.trim().slice(0, MAX_LEN);
  } catch {
    /* */
  }
  return getDefaultDeviceName();
}

/** Persist a custom name. Empty string clears override. */
export async function setDisplayName(name: string): Promise<void> {
  const clean = (name || '').trim().slice(0, MAX_LEN);
  if (clean) {
    await AsyncStorage.setItem(KEY, clean);
  } else {
    await AsyncStorage.removeItem(KEY);
  }
}

export async function clearDisplayName(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    /* */
  }
}

/** True when user has set a custom name. */
export async function hasCustomDisplayName(): Promise<boolean> {
  try {
    const saved = await AsyncStorage.getItem(KEY);
    return !!(saved && saved.trim());
  } catch {
    return false;
  }
}
