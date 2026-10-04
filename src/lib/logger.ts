/**
 * In-app diagnostic logger.
 * Fixed-size ring buffer; export via Settings (copy / share).
 * Does not upload anywhere. Avoids logging full file paths by default.
 */

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type LogLevel = 'info' | 'warn' | 'error';

export type LogEntry = {
  ts: number;
  level: LogLevel;
  tag: string;
  message: string;
};

const MAX_ENTRIES = 400;
const STORAGE_KEY = 'localdrop_diag_logs_v1';
const VERBOSE_KEY = 'localdrop_diag_verbose';

const buffer: LogEntry[] = [];
let verbose = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let loaded = false;

function pad(n: number, w = 2) {
  return String(n).padStart(w, '0');
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  return (
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${pad(d.getMilliseconds(), 3)}`
  );
}

function push(level: LogLevel, tag: string, message: string) {
  const entry: LogEntry = {
    ts: Date.now(),
    level,
    tag: (tag || 'app').slice(0, 24),
    message: String(message || '').slice(0, 500),
  };
  buffer.push(entry);
  while (buffer.length > MAX_ENTRIES) buffer.shift();

  // Also mirror to Metro / logcat for local debug
  const line = `${formatTs(entry.ts)} [${entry.tag}] ${entry.message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  schedulePersist();
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistNow();
  }, 1500);
}

async function persistNow() {
  try {
    const slim = buffer.slice(-200).map((e) => ({
      t: e.ts,
      l: e.level[0],
      g: e.tag,
      m: e.message,
    }));
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
  } catch {
    /* */
  }
}

/** Load previous session logs once (best-effort). */
export async function initLogger(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const [raw, v] = await Promise.all([
      AsyncStorage.getItem(STORAGE_KEY),
      AsyncStorage.getItem(VERBOSE_KEY),
    ]);
    verbose = v === '1' || v === 'true';
    if (raw) {
      const parsed = JSON.parse(raw) as Array<{ t: number; l: string; g: string; m: string }>;
      if (Array.isArray(parsed)) {
        for (const row of parsed.slice(-150)) {
          const level: LogLevel =
            row.l === 'e' ? 'error' : row.l === 'w' ? 'warn' : 'info';
          buffer.push({
            ts: row.t || Date.now(),
            level,
            tag: row.g || 'app',
            message: row.m || '',
          });
        }
        while (buffer.length > MAX_ENTRIES) buffer.shift();
      }
    }
  } catch {
    /* */
  }
  push('info', 'app', `logger ready · ${Platform.OS}`);
}

export function logInfo(tag: string, message: string) {
  push('info', tag, message);
}

export function logWarn(tag: string, message: string) {
  push('warn', tag, message);
}

export function logError(tag: string, message: string) {
  push('error', tag, message);
}

/** Only written when verbose is on (ICE detail, etc.). */
export function logVerbose(tag: string, message: string) {
  if (!verbose) return;
  push('info', tag, message);
}

export function isVerboseLogging(): boolean {
  return verbose;
}

export async function setVerboseLogging(on: boolean): Promise<void> {
  verbose = on;
  try {
    await AsyncStorage.setItem(VERBOSE_KEY, on ? '1' : '0');
  } catch {
    /* */
  }
  push('info', 'app', `verbose logging ${on ? 'on' : 'off'}`);
}

export function getLogEntries(): LogEntry[] {
  return buffer.slice();
}

export function formatLogsForExport(entries: LogEntry[] = buffer): string {
  const header = [
    'LocalDrop diagnostics',
    `platform=${Platform.OS}`,
    `entries=${entries.length}`,
    '---',
  ].join('\n');
  const lines = entries.map((e) => {
    const lvl = e.level === 'error' ? 'E' : e.level === 'warn' ? 'W' : 'I';
    return `${formatTs(e.ts)} ${lvl} [${e.tag}] ${e.message}`;
  });
  return header + '\n' + lines.join('\n');
}

export async function clearLogs(): Promise<void> {
  buffer.length = 0;
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    /* */
  }
  push('info', 'app', 'logs cleared');
}

/** Shorten a display name / path for privacy in shared logs. */
export function redactName(name?: string | null): string {
  if (!name) return '(none)';
  const n = name.trim();
  if (n.length <= 24) return n;
  return n.slice(0, 12) + '…' + n.slice(-8);
}

/** Privacy-safe description of a file URI: scheme, provider authority, kind. No file names/paths. */
export function describeUri(uri?: string | null): string {
  if (!uri) return 'uri=(none)';
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i.exec(uri);
  if (!m) return 'uri=(unparsed)';
  const [, scheme, authority, path] = m;
  const segs = path.split('/').filter(Boolean);
  let kind = '';
  if (segs.includes('tree')) kind = ' kind=tree';
  else if (segs.includes('document')) kind = ' kind=document';
  const id = segs[segs.length - 1] || '';
  let idPrefix: string | undefined;
  try {
    idPrefix = /^([a-z]+):/i.exec(decodeURIComponent(id))?.[1];
  } catch {
    /* malformed escape — leave undefined */
  }
  // A SAF document URI has exactly ONE path segment after "document" (the id is %-encoded).
  // More than one means the URI was percent-decoded somewhere (e.g. via router params) and
  // Android will refuse it even though the picker granted access to the original.
  const di = segs.indexOf('document');
  const decodedSuspect = scheme === 'content' && di >= 0 && segs.length - di - 1 > 1;
  return `scheme=${scheme} authority=${authority || '(none)'}${kind}${idPrefix ? ` idPrefix=${idPrefix}` : ''}${decodedSuspect ? ' [URI-DECODED?]' : ''}`;
}

/** Name + message + native code for an unknown thrown value. */
export function describeError(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return `${e.name}: ${e.message}${code != null ? ` (code=${String(code)})` : ''}`;
  }
  return String(e);
}
