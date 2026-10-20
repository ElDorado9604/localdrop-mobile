/** Pure helpers for the permission rows (kept free of React Native imports for testing). */

export type PermKey = 'notifications' | 'battery' | 'camera';
export type PermResult = 'granted' | 'denied' | 'blocked';

export const PERMISSION_ROWS: { key: PermKey; title: string; body: string }[] = [
  {
    key: 'notifications',
    title: 'Transfer notifications',
    body: 'Shows progress and keeps transfers running while you use other apps.',
  },
  {
    key: 'battery',
    title: 'Run without battery limits',
    body: 'Stops your phone from pausing large transfers in the background.',
  },
  {
    key: 'camera',
    title: 'Camera (QR pairing)',
    body: 'Only needed to scan a QR code when pairing offline.',
  },
];

export function permissionButtonLabel(granted: boolean, previous?: PermResult): string | null {
  if (granted) return null;
  if (previous === 'blocked') return 'Open settings';
  if (previous === 'denied') return 'Try again';
  return 'Allow';
}

export function allGranted(states: Record<PermKey, boolean>): boolean {
  return states.notifications && states.battery && states.camera;
}

/**
 * Home-screen reminder text. Only notifications and the battery exemption matter for background
 * transfers (camera is only for QR pairing), so only those are mentioned.
 */
export function backgroundBannerText(
  states: Record<PermKey, boolean>
): { title: string; body: string } | null {
  const missing: string[] = [];
  if (!states.notifications) missing.push('notifications');
  if (!states.battery) missing.push('battery access');
  if (missing.length === 0) return null;
  return {
    title: 'Background transfers may pause',
    body: `Allow ${missing.join(' and ')} so large transfers keep running while you use other apps.`,
  };
}
