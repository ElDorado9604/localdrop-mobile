/**
 * Pure text helpers for the background-transfer notification (no React Native imports,
 * so they can be unit-tested).
 */
import { formatBytes, formatSpeed } from './transferProtocol';

export type NotificationRole = 'sender' | 'receiver';

export type ProgressInput = {
  role: NotificationRole;
  peerName?: string;
  bytesDone: number;
  bytesTotal: number;
  speed: number;
};

export type ProgressNotification = {
  title: string;
  text: string;
  subText?: string;
  /** 0..100, or -1 for an indeterminate bar. */
  progress: number;
};

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${Math.ceil(seconds)} s left`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h left` : `${hours} h ${rest} min left`;
}

function peerLabel(role: NotificationRole, peerName?: string): string {
  if (!peerName || peerName === 'peer') return '';
  return ` ${role === 'sender' ? 'to' : 'from'} ${peerName}`;
}

export function buildProgressNotification(i: ProgressInput): ProgressNotification {
  const title = `${i.role === 'sender' ? 'Sending' : 'Receiving'}${peerLabel(i.role, i.peerName)}`;

  if (i.bytesTotal <= 0) {
    return { title, text: 'Preparing…', progress: -1 };
  }
  if (i.bytesDone <= 0) {
    return {
      title,
      text: i.role === 'sender' ? 'Waiting for the other device…' : 'Starting…',
      progress: 0,
    };
  }

  const done = Math.min(i.bytesDone, i.bytesTotal);
  const progress = Math.max(0, Math.min(100, Math.round((done / i.bytesTotal) * 100)));
  const text = `${progress}% · ${formatBytes(done)} / ${formatBytes(i.bytesTotal)}`;

  let subText: string | undefined;
  if (i.speed > 0) {
    const eta = formatEta((i.bytesTotal - done) / i.speed);
    subText = eta ? `${formatSpeed(i.speed)} · ${eta}` : formatSpeed(i.speed);
  }
  return { title, text, subText, progress };
}

export type ResultInput = {
  role: NotificationRole;
  peerName?: string;
  outcome: 'completed' | 'failed';
  bytesTotal: number;
  error?: string | null;
};

export function buildResultNotification(i: ResultInput): { title: string; text: string } {
  const peer = peerLabel(i.role, i.peerName);
  if (i.outcome === 'completed') {
    const size = i.bytesTotal > 0 ? ` (${formatBytes(i.bytesTotal)})` : '';
    return {
      title: 'Transfer complete',
      text: `${i.role === 'sender' ? 'Sent' : 'Received'}${peer}${size}`,
    };
  }
  return {
    title: 'Transfer failed',
    text: i.error ? i.error : `The transfer${peer} did not finish.`,
  };
}
