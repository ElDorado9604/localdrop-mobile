/**
 * Pure formatting of the native environment snapshot into Diagnostics log lines
 * (no React Native imports, so it can be unit-tested).
 */
import type { EnvironmentSnapshot } from '../../modules/transfer-service';

export type EnvLine = { level: 'info' | 'warn'; message: string };

const KEY_PERMISSIONS = [
  'INTERNET',
  'ACCESS_NETWORK_STATE',
  'ACCESS_WIFI_STATE',
  'CHANGE_WIFI_MULTICAST_STATE',
  'CAMERA',
  'RECORD_AUDIO',
  'POST_NOTIFICATIONS',
  'FOREGROUND_SERVICE_DATA_SYNC',
  'NEARBY_WIFI_DEVICES',
  'ACCESS_FINE_LOCATION',
  'ACCESS_LOCAL_NETWORK',
];

/** Legacy storage permissions are always "not granted" on Android 11+ and are not used. */
const IGNORED_DENIED = new Set(['READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE']);

const onOff = (v: boolean | undefined) => (v === undefined ? '?' : v ? 'on' : 'off');
const yesNo = (v: boolean | undefined) => (v === undefined ? '?' : v ? 'yes' : 'no');

export type WifiRole = 'hotspot-host' | 'wifi-client' | 'wifi-client+hotspot' | 'none';

const HOTSPOT_IFACE = /^(ap\d*|swlan\d*|softap\d*|wlan[1-9]\d*)$/i;

/**
 * Best-effort guess: Android has no public "is the hotspot on" API, so combine the Wi-Fi switch,
 * the Wi-Fi networks and hotspot-style interface names.
 */
export function wifiRole(s: EnvironmentSnapshot): { role: WifiRole; reason: string } {
  const wifiNetworks = s.networks.filter((n) => n.transports.includes('WIFI'));
  const apIface = s.interfaces.find((i) => HOTSPOT_IFACE.test(i.name));
  const switchOn = s.wifiEnabled === true;

  if (switchOn && wifiNetworks.length > 0 && apIface) {
    return { role: 'wifi-client+hotspot', reason: `Wi-Fi on with a network and ${apIface.name} up` };
  }
  if (apIface) {
    return { role: 'hotspot-host', reason: `hotspot interface ${apIface.name} has IPv4` };
  }
  if (!switchOn && wifiNetworks.length > 0) {
    return {
      role: 'hotspot-host',
      reason: 'Wi-Fi switch is off but a Wi-Fi network is up (typical when sharing a hotspot)',
    };
  }
  if (switchOn && wifiNetworks.length > 0) {
    return { role: 'wifi-client', reason: 'Wi-Fi on and connected to a network' };
  }
  if (switchOn) return { role: 'none', reason: 'Wi-Fi on but not connected to any network' };
  return { role: 'none', reason: 'Wi-Fi off and no hotspot detected' };
}

function wifiBand(freq?: number): string {
  if (!freq) return '';
  if (freq < 3000) return '2.4GHz';
  if (freq < 5925) return '5GHz';
  return '6GHz';
}

export function internetState(s: EnvironmentSnapshot): 'online' | 'no-internet' | 'no-network' {
  if (s.networks.some((n) => n.internet && n.validated)) return 'online';
  return s.networks.length > 0 ? 'no-internet' : 'no-network';
}

export function permissionState(
  s: EnvironmentSnapshot,
  name: string
): 'granted' | 'DENIED' | 'not declared' {
  if (s.permissions.granted.includes(name)) return 'granted';
  if (s.permissions.denied.includes(name)) return 'DENIED';
  return 'not declared';
}

/** Stable signature of the granted set, to detect a permission changing between checks. */
export function permissionSignature(s: EnvironmentSnapshot): string {
  return [...s.permissions.granted].sort().join(',');
}

export function diffPermissions(
  prevSig: string,
  s: EnvironmentSnapshot
): { added: string[]; removed: string[] } {
  const prev = new Set(prevSig ? prevSig.split(',') : []);
  const now = new Set(s.permissions.granted);
  return {
    added: [...now].filter((p) => !prev.has(p)).sort(),
    removed: [...prev].filter((p) => !now.has(p)).sort(),
  };
}

export function formatEnvironment(context: string, s: EnvironmentSnapshot): EnvLine[] {
  const lines: EnvLine[] = [];
  const state = internetState(s);
  const head =
    `env[${context}] ${s.device} api=${s.sdk} internet=${state} airplane=${onOff(s.airplane)} ` +
    `wifi=${onOff(s.wifiEnabled)} notifications=${onOff(s.notificationsEnabled)} ` +
    `batteryExempt=${yesNo(s.batteryExempt)} powerSave=${onOff(s.powerSave)}`;
  lines.push({ level: state === 'online' ? 'info' : 'warn', message: head });

  const nets = s.networks.length
    ? s.networks
        .map(
          (n) =>
            `${n.transports.join('+') || 'UNKNOWN'}(${n.iface || '?'}) internet=${n.internet} ` +
            `validated=${n.validated}${n.active ? ' ACTIVE' : ''} addrs=[${n.addrs.join(',')}]`
        )
        .join(' ; ')
    : 'none';
  lines.push({ level: 'info', message: `env[${context}] networks: ${nets}` });

  const wr = wifiRole(s);
  const link =
    s.wifiLinkMbps && s.wifiLinkMbps > 0
      ? ` link=${s.wifiLinkMbps}Mbps ${wifiBand(s.wifiFreqMhz)} rssi=${s.wifiRssi}dBm`.replace('  ', ' ')
      : '';
  lines.push({
    level: wr.role === 'none' ? 'warn' : 'info',
    message: `env[${context}] wifiRole=${wr.role} (guess: ${wr.reason})${link}`,
  });

  const ifaces = s.interfaces.length
    ? s.interfaces.map((i) => `${i.name}=${i.ipv4.join(',')}`).join(' ')
    : 'none with IPv4';
  lines.push({ level: 'info', message: `env[${context}] interfaces: ${ifaces}` });
  if (s.interfaces.length === 0) {
    lines.push({
      level: 'warn',
      message: `env[${context}] no IPv4 address on any interface — offline pairing needs Wi-Fi (same network) or a hotspot`,
    });
  }

  const keys = KEY_PERMISSIONS.map((k) => `${k}=${permissionState(s, k)}`).join(' ');
  const denied = s.permissions.denied.filter(
    (p) => !(s.sdk >= 30 && IGNORED_DENIED.has(p))
  );
  lines.push({
    level: 'info',
    message: `env[${context}] permissions: ${keys} | not granted: [${denied.join(',')}]`,
  });

  for (const err of [s.networkError, s.interfaceError, s.permissionError]) {
    if (err) lines.push({ level: 'warn', message: `env[${context}] snapshot error: ${err}` });
  }
  return lines;
}
