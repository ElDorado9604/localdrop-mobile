import { describe, it, expect } from 'vitest';
import {
  buildProgressNotification,
  buildResultNotification,
  formatEta,
} from './transferNotificationText';

describe('buildProgressNotification', () => {
  it('is indeterminate until the total size is known', () => {
    const n = buildProgressNotification({
      role: 'receiver',
      bytesDone: 0,
      bytesTotal: 0,
      speed: 0,
    });
    expect(n.progress).toBe(-1);
    expect(n.title).toBe('Receiving');
  });

  it('tells the sender it is waiting for the receiver before any byte moved', () => {
    const n = buildProgressNotification({
      role: 'sender',
      peerName: 'Redmi 10',
      bytesDone: 0,
      bytesTotal: 520_000_000,
      speed: 0,
    });
    expect(n.title).toBe('Sending to Redmi 10');
    expect(n.text).toBe('Waiting for the other device…');
    expect(n.progress).toBe(0);
  });

  it('shows percent, sizes, speed and ETA while transferring', () => {
    const n = buildProgressNotification({
      role: 'sender',
      peerName: 'Moto',
      bytesDone: 260_000_000,
      bytesTotal: 520_000_000,
      speed: 5_000_000,
    });
    expect(n.progress).toBe(50);
    expect(n.text).toBe('50% · 260.0 MB / 520.0 MB');
    expect(n.subText).toBe('5.0 MB/s · 52 s left');
  });

  it('never exceeds 100% and ignores the placeholder peer name', () => {
    const n = buildProgressNotification({
      role: 'receiver',
      peerName: 'peer',
      bytesDone: 2_000,
      bytesTotal: 1_000,
      speed: 0,
    });
    expect(n.progress).toBe(100);
    expect(n.title).toBe('Receiving');
    expect(n.subText).toBeUndefined();
  });
});

describe('formatEta', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatEta(30)).toBe('30 s left');
    expect(formatEta(61)).toBe('2 min left');
    expect(formatEta(3600)).toBe('1 h left');
    expect(formatEta(5400)).toBe('1 h 30 min left');
    expect(formatEta(0)).toBe('');
    expect(formatEta(Infinity)).toBe('');
  });
});

describe('buildResultNotification', () => {
  it('describes success and failure', () => {
    expect(
      buildResultNotification({
        role: 'receiver',
        peerName: 'Moto',
        outcome: 'completed',
        bytesTotal: 520_000_000,
      })
    ).toEqual({ title: 'Transfer complete', text: 'Received from Moto (520.0 MB)' });

    expect(
      buildResultNotification({
        role: 'sender',
        outcome: 'failed',
        bytesTotal: 10,
        error: 'Connection closed',
      })
    ).toEqual({ title: 'Transfer failed', text: 'Connection closed' });
  });
});
