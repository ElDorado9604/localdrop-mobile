import { describe, it, expect, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-file-system/legacy', () => ({}));
vi.mock('expo-sharing', () => ({}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));

import { setPendingFiles, getPendingFiles, clearPendingFiles } from './pendingFilesStore';
import { describeUri } from './logger';

const ORIGINAL =
  'content://com.android.externalstorage.documents/document/primary%3ADownload%2FLocalDrop%2Fimages%202.pdf';

describe('pendingFilesStore', () => {
  it('hands files over with URIs byte-for-byte intact, and clears', () => {
    setPendingFiles([
      { id: 'a', name: 'images 2.pdf', size: 1, type: 'application/pdf', uri: ORIGINAL, status: 'pending', progress: 0 },
    ]);
    expect(getPendingFiles()![0].uri).toBe(ORIGINAL);
    expect(getPendingFiles()).not.toBeNull(); // non-destructive read
    clearPendingFiles();
    expect(getPendingFiles()).toBeNull();
  });
});

describe('router-param regression (why the store exists)', () => {
  it('decodeURIComponent on the JSON param changes the SAF URI', () => {
    const json = JSON.stringify([{ uri: ORIGINAL }]);
    const afterRouter = JSON.parse(decodeURIComponent(json))[0].uri;
    expect(afterRouter).not.toBe(ORIGINAL);
    expect(afterRouter).toContain('primary:Download/LocalDrop/images 2.pdf');
  });

  it('describeUri flags a decoded SAF URI but not an intact one', () => {
    expect(describeUri(ORIGINAL)).not.toContain('URI-DECODED');
    const decoded = decodeURIComponent(ORIGINAL);
    expect(describeUri(decoded)).toContain('[URI-DECODED?]');
  });
});
