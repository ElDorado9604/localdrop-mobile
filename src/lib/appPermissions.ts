/**
 * Permissions that make background transfers reliable. None of them is required for a transfer
 * to work; they are asked for once in the first-launch setup and can be changed in Settings.
 * Transfers themselves never show a permission dialog.
 */
import { Linking, PermissionsAndroid, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getEnvironmentSnapshot,
  isIgnoringBatteryOptimizations,
  requestIgnoreBatteryOptimizations,
} from 'transfer-service';
import { logInfo, logWarn } from './logger';
import type { PermKey, PermResult } from './permissionUi';

const SETUP_KEY = 'localdrop.setupDone.v1';

export async function isSetupDone(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(SETUP_KEY)) === '1';
  } catch {
    return true; // never trap the user in setup
  }
}

export async function markSetupDone(): Promise<void> {
  try {
    await AsyncStorage.setItem(SETUP_KEY, '1');
  } catch {
    /* ignore */
  }
}

export async function openAppSettings(): Promise<void> {
  try {
    await Linking.openSettings();
  } catch {
    /* ignore */
  }
}

export async function getPermissionStates(): Promise<Record<PermKey, boolean>> {
  if (Platform.OS !== 'android') return { notifications: true, battery: true, camera: true };

  let notifications = true;
  try {
    if (Number(Platform.Version) >= 33) {
      notifications = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
      );
    } else {
      notifications = (await getEnvironmentSnapshot())?.notificationsEnabled ?? true;
    }
  } catch {
    /* assume granted */
  }

  let camera = true;
  try {
    camera = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CAMERA);
  } catch {
    /* assume granted */
  }

  const battery = await isIgnoringBatteryOptimizations();
  return { notifications, battery, camera };
}

function mapResult(res: string): PermResult {
  if (res === PermissionsAndroid.RESULTS.GRANTED) return 'granted';
  if (res === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) return 'blocked';
  return 'denied';
}

/**
 * Ask for one permission. The battery dialog is a separate system screen, so its outcome is only
 * known after the app resumes (callers refresh then); the result here is 'denied' until then.
 */
export async function requestPermission(key: PermKey): Promise<PermResult> {
  if (Platform.OS !== 'android') return 'granted';
  let result: PermResult = 'denied';
  try {
    if (key === 'notifications') {
      if (Number(Platform.Version) >= 33) {
        result = mapResult(
          await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)
        );
      } else {
        // Below Android 13 there is no runtime prompt: notifications were turned off in settings.
        result = 'blocked';
      }
    } else if (key === 'camera') {
      result = mapResult(await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA));
    } else {
      const opened = await requestIgnoreBatteryOptimizations();
      result = opened ? 'denied' : 'blocked';
    }
  } catch (e) {
    logWarn('setup', `request ${key} failed: ${String(e)}`);
  }
  logInfo('setup', `request ${key} -> ${result}`);
  return result;
}
