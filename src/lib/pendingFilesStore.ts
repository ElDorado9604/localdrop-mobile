/**
 * Hands the files picked on the Send screen to the Transfer screen.
 *
 * Do NOT pass file URIs through router params: expo-router's useLocalSearchParams()
 * runs decodeURIComponent() on every value, which turns the percent-encoded SAF document
 * id (…/document/primary%3ADownload%2FLocalDrop%2Fimages%202.pdf) into a *different* URI
 * (…/document/primary:Download/LocalDrop/images 2.pdf). Android then refuses to read it
 * ("Permission Denial … requires that you obtain access using ACTION_OPEN_DOCUMENT")
 * because the picker's grant belongs to the original URI only.
 */

export type PendingFile = {
  id: string;
  name: string;
  size: number;
  type: string;
  uri?: string;
  status: 'pending';
  progress: number;
};

let pending: PendingFile[] | null = null;

export function setPendingFiles(files: PendingFile[]) {
  pending = files;
}

/** Non-destructive (effects may run twice); call clearPendingFiles() when the screen unmounts. */
export function getPendingFiles(): PendingFile[] | null {
  return pending;
}

export function clearPendingFiles() {
  pending = null;
}
