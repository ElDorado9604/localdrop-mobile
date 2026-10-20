/**
 * Status + Allow buttons for the permissions that keep background transfers reliable.
 * Used by the first-launch setup screen and by Settings.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  getPermissionStates,
  openAppSettings,
  requestPermission,
} from '../lib/appPermissions';
import {
  PERMISSION_ROWS,
  permissionButtonLabel,
  type PermKey,
  type PermResult,
} from '../lib/permissionUi';

type States = Record<PermKey, boolean>;

export function BackgroundPermissions({ onChange }: { onChange?: (s: States) => void }) {
  const [states, setStates] = useState<States | null>(null);
  const [previous, setPrevious] = useState<Partial<Record<PermKey, PermResult>>>({});

  const refresh = useCallback(async () => {
    const s = await getPermissionStates();
    setStates(s);
    onChange?.(s);
  }, [onChange]);

  useEffect(() => {
    void refresh();
    // The battery dialog and the system settings page are separate screens: re-check on return.
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') void refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  async function onPress(key: PermKey) {
    if (previous[key] === 'blocked') {
      await openAppSettings();
      return;
    }
    const res = await requestPermission(key);
    setPrevious((p) => ({ ...p, [key]: res }));
    if (res === 'blocked' && key === 'battery') await openAppSettings();
    await refresh();
  }

  return (
    <View>
      {PERMISSION_ROWS.map((row) => {
        const granted = states ? states[row.key] : false;
        const label = states ? permissionButtonLabel(granted, previous[row.key]) : null;
        return (
          <View key={row.key} style={styles.row}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={styles.title}>{row.title}</Text>
              <Text style={styles.body}>{row.body}</Text>
            </View>
            {states && granted ? (
              <Text style={styles.ok}>✓ Allowed</Text>
            ) : label ? (
              <Pressable style={styles.btn} onPress={() => void onPress(row.key)}>
                <Text style={styles.btnText}>{label}</Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', marginTop: 14 },
  title: { color: '#fff', fontWeight: '700', fontSize: 15, marginBottom: 4 },
  body: { color: '#94a3b8', fontSize: 13, lineHeight: 18 },
  ok: { color: '#22c55e', fontWeight: '700', fontSize: 13 },
  btn: {
    backgroundColor: '#1d4ed8',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
});
