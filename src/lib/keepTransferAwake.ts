/**
 * Keep the screen on while a transfer is active.
 * Call with true when phase === 'transferring', false otherwise.
 */
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

const TAG = 'localdrop-transfer';

export async function setTransferKeepAwake(active: boolean): Promise<void> {
  try {
    if (active) {
      await activateKeepAwakeAsync(TAG);
    } else {
      deactivateKeepAwake(TAG);
    }
  } catch {
    /* keep-awake not critical */
  }
}
