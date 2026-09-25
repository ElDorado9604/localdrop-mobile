/**
 * Friendly device display name for pairing screens.
 * Priority: user-saved name → system deviceName → modelName → fallback.
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Device from 'expo-device';

const KEY = 'localdrop_display_name';

export async function getDisplayName(): Promise<string> {
  try {
    const saved = await AsyncStorage.getItem(KEY);
    if (saved && saved.trim()) return saved.trim().slice(0, 40);
  } catch {
    /* */
  }

  // User-assigned name (e.g. "Ashish’s Pixel")
  const systemName = Device.deviceName?.trim();
  if (systemName && systemName.length > 1) return systemName.slice(0, 40);

  // Model (e.g. "Pixel 6 Pro")
  const model = Device.modelName?.trim();
  if (model) return model.slice(0, 40);

  return Platform.OS === 'ios' ? 'iPhone' : 'Android Device';
}

export async function setDisplayName(name: string): Promise<void> {
  const clean = (name || '').trim().slice(0, 40);
  if (clean) {
    await AsyncStorage.setItem(KEY, clean);
  } else {
    await AsyncStorage.removeItem(KEY);
  }
}
