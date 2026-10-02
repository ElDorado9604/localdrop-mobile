/** Online (web ↔ mobile): match web app 64 KB chunks */
export const ONLINE_CHUNK_SIZE = 64 * 1024;

/** Offline (mobile ↔ mobile LAN/hotspot): larger chunks for throughput */
export const OFFLINE_CHUNK_SIZE = 256 * 1024;

/** @deprecated Prefer ONLINE_CHUNK_SIZE or OFFLINE_CHUNK_SIZE */
export const CHUNK_SIZE = OFFLINE_CHUNK_SIZE;

export const MAX_FILE_SIZE = 200 * 1024 * 1024 * 1024; // 200 GB theoretical max (streaming required)

export type FileMeta = {
  id: string;
  name: string;
  size: number;
  type: string;
};

export type ProtocolMessage =
  | { type: 'transfer-offer'; files: FileMeta[]; totalSize: number; senderName: string }
  | { type: 'transfer-accepted' }
  | { type: 'transfer-rejected'; reason?: string }
  | {
      type: 'file-start';
      fileId: string;
      name: string;
      mime: string;
      size: number;
      index: number;
      totalFiles: number;
    }
  | { type: 'file-complete'; fileId: string }
  | { type: 'transfer-complete' }
  | { type: 'transfer-ack' }
  | { type: 'transfer-cancelled' }
  | { type: 'transfer-error'; message: string };

export function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function canFinalizeTransferAsReceiver({
  allFilesCompleted,
  peerSentTransferComplete,
}: {
  allFilesCompleted: boolean;
  peerSentTransferComplete: boolean;
}): boolean {
  return allFilesCompleted && peerSentTransferComplete;
}

export function canFinalizeTransferAsSender({
  allFilesCompleted,
  peerSentTransferAck,
}: {
  allFilesCompleted: boolean;
  peerSentTransferAck: boolean;
}): boolean {
  return allFilesCompleted && peerSentTransferAck;
}
