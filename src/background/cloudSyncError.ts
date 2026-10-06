import { syncErrorText, type SyncErrorCode } from '../shared/syncErrors';

/**
 * A cloud-sync failure: a code (stored in the sync state and worded by the
 * page that shows it) and its message in the current language (for an
 * immediate answer and the debug log). Anything that is not a CloudSyncError
 * is reported as `failed`, so raw transport/SDK details never reach the UI or
 * logs.
 */
export class CloudSyncError extends Error {
  readonly code: SyncErrorCode;
  readonly detail: string | null;

  constructor(code: SyncErrorCode, detail: string | null = null) {
    super(syncErrorText(code, detail));
    this.name = 'CloudSyncError';
    this.code = code;
    this.detail = detail;
  }
}
