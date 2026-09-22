/**
 * A cloud-sync failure whose message is safe to show to the user and to store
 * in the sync state. Anything that is not a CloudSyncError is reported with a
 * generic message so raw transport/SDK details never reach the UI or logs.
 */
export class CloudSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudSyncError';
  }
}
