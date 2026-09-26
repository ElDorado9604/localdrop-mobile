export const CHUNK_SIZE = 256 * 1024; // 256 KB — better throughput on LAN/hotspot
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
