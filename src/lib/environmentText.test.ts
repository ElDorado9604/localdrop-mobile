import { describe, it, expect } from 'vitest';
import {
  diffPermissions,
  formatEnvironment,
  internetState,
  permissionSignature,
  permissionState,
} from './environmentText';
import type { EnvironmentSnapshot } from '../../modules/transfer-service';

const base: EnvironmentSnapshot = {
  sdk: 35,
  device: 'motorola motorola edge 50 pro',
  notificationsEnabled: true,
  batteryExempt: false,
  powerSave: false,
  airplane: false,
  wifiEnabled: true,
  networks: [],
  interfaces: [],
  permissions: { granted: ['INTERNET', 'CAMERA'], denied: ['POST_NOTIFICATIONS', 'WRITE_EXTERNAL_STORAGE'] },
};

describe('internetState', () => {
  it('distinguishes online, connected-without-internet and no network', () => {
    expect(internetState(base)).toBe('no-network');
    expect(
      internetState({
        ...base,
        networks: [
          { transports: ['WIFI'], internet: true, validated: false, active: false, iface: 'wlan0', addrs: [] },
        ],
      })
    ).toBe('no-internet');
    expect(
      internetState({
        ...base,
        networks: [
          { transports: ['CELLULAR'], internet: true, validated: true, active: true, iface: 'rmnet0', addrs: [] },
        ],
      })
    ).toBe('online');
  });
});

describe('permissionState', () => {
  it('reports granted, DENIED and not declared', () => {
    expect(permissionState(base, 'CAMERA')).toBe('granted');
    expect(permissionState(base, 'POST_NOTIFICATIONS')).toBe('DENIED');
    expect(permissionState(base, 'NEARBY_WIFI_DEVICES')).toBe('not declared');
  });
});

describe('diffPermissions', () => {
  it('detects a permission granted between two checks', () => {
    const before = permissionSignature(base);
    const after = { ...base, permissions: { granted: ['INTERNET', 'CAMERA', 'POST_NOTIFICATIONS'], denied: [] } };
    expect(diffPermissions(before, after)).toEqual({ added: ['POST_NOTIFICATIONS'], removed: [] });
  });
});

describe('formatEnvironment', () => {
  it('warns when there is no network and no IPv4 interface', () => {
    const lines = formatEnvironment('offline-host', base);
    expect(lines[0].level).toBe('warn');
    expect(lines[0].message).toContain('internet=no-network');
    expect(lines.some((l) => l.message.includes('no IPv4 address on any interface'))).toBe(true);
    const perms = lines.find((l) => l.message.includes('permissions:'))!;
    expect(perms.message).toContain('CAMERA=granted');
    expect(perms.message).toContain('NEARBY_WIFI_DEVICES=not declared');
    expect(perms.message).toContain('not granted: [POST_NOTIFICATIONS]');
  });

  it('is quiet when online with a Wi-Fi address', () => {
    const lines = formatEnvironment('transfer', {
      ...base,
      networks: [
        { transports: ['WIFI'], internet: true, validated: true, active: true, iface: 'wlan0', addrs: ['192.168.1.20'] },
      ],
      interfaces: [{ name: 'wlan0', ipv4: ['192.168.1.20'] }],
    });
    expect(lines.every((l) => l.level === 'info')).toBe(true);
    expect(lines[1].message).toContain('WIFI(wlan0) internet=true validated=true ACTIVE addrs=[192.168.1.20]');
  });
});
