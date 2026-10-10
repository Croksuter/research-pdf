// ─── Sync errors: stored as codes, worded where they are shown ───
//
// The sync state keeps what went wrong as a code (plus a detail such as an
// HTTP status), never as a sentence, so the settings page and the popup show
// it in the language they are in now, not the one the service worker was in
// when it failed. A state an older build stored still carries its sentence in
// `error`; that is shown as it is.

import { S } from './shared.strings';

export const SYNC_ERROR_CODES = [
  // Google sign-in
  'auth-bad-response', 'auth-verify-failed', 'auth-expired', 'auth-denied', 'auth-failed', 'auth-drive-denied',
  'auth-server-unreachable', 'token-verify-failed', 'not-configured', 'auth-cancelled', 'account-mismatch',
  // Google Drive
  'drive-file-too-large', 'drive-read-failed', 'drive-quota', 'drive-rate-limited', 'drive-denied', 'drive-http',
  'drive-bad-url', 'timeout', 'drive-unreachable', 'drive-bad-response', 'drive-upload-session', 'drive-upload-unverified',
  'account-info-failed', 'drive-file-changing',
  // PDF files in the user's Drive folder
  'files-consent', 'files-off', 'no-local-copy',
  // The sync run
  'account-changed', 'file-invalid', 'file-too-new', 'connect-first', 'sync-off', 'failed', 'conflict',
] as const;

export type SyncErrorCode = typeof SYNC_ERROR_CODES[number];

export function isSyncErrorCode(value: unknown): value is SyncErrorCode {
  return typeof value === 'string' && (SYNC_ERROR_CODES as readonly string[]).includes(value);
}

const TEXT: Record<SyncErrorCode, (detail: string | null) => string> = {
  'auth-bad-response': () => S.syncErrAuthBadResponse,
  'auth-verify-failed': () => S.syncErrAuthVerifyFailed,
  'auth-expired': () => S.syncErrAuthExpired,
  'auth-denied': () => S.syncErrAuthDenied,
  'auth-failed': () => S.syncErrAuthFailed,
  'auth-drive-denied': () => S.syncErrAuthDriveDenied,
  'auth-server-unreachable': () => S.syncErrAuthServerUnreachable,
  'token-verify-failed': () => S.syncErrTokenVerifyFailed,
  'not-configured': () => S.syncErrNotConfigured,
  'auth-cancelled': () => S.syncErrAuthCancelled,
  'account-mismatch': () => S.syncErrAccountMismatch,
  'drive-file-too-large': () => S.syncErrDriveFileTooLarge,
  'drive-read-failed': () => S.syncErrDriveReadFailed,
  'drive-quota': () => S.syncErrDriveQuota,
  'drive-rate-limited': () => S.syncErrDriveRateLimited,
  'drive-denied': () => S.syncErrDriveDenied,
  'drive-http': (detail) => S.syncErrDriveHttp(detail ?? '?'),
  'drive-bad-url': () => S.syncErrDriveBadUrl,
  timeout: () => S.syncErrTimeout,
  'drive-unreachable': () => S.syncErrDriveUnreachable,
  'drive-bad-response': () => S.syncErrDriveBadResponse,
  'drive-upload-session': () => S.syncErrDriveUploadSession,
  'drive-upload-unverified': () => S.syncErrDriveUploadUnverified,
  'account-info-failed': () => S.syncErrAccountInfoFailed,
  'drive-file-changing': () => S.syncErrDriveFileChanging,
  'files-consent': () => S.syncErrFilesConsent,
  'files-off': () => S.syncErrFilesOff,
  'no-local-copy': () => S.syncErrNoLocalCopy,
  'account-changed': () => S.syncErrAccountChanged,
  'file-invalid': () => S.syncErrFileInvalid,
  'file-too-new': () => S.syncErrFileTooNew,
  'connect-first': () => S.syncErrConnectFirst,
  'sync-off': () => S.syncErrSyncOff,
  failed: () => S.syncErrFailed,
  conflict: () => S.syncErrConflict,
};

/** The sentence for a code, in the current language. */
export function syncErrorText(code: SyncErrorCode, detail: string | null = null): string {
  return TEXT[code](detail);
}

/**
 * What a sync status (or a failed sync's answer) shows: its code worded now,
 * else the sentence an older build stored, else null.
 */
export function syncStatusErrorText(status: { errorCode?: unknown; errorDetail?: unknown; error?: unknown } | null | undefined): string | null {
  if (!status) return null;
  if (isSyncErrorCode(status.errorCode)) return syncErrorText(status.errorCode, typeof status.errorDetail === 'string' ? status.errorDetail : null);
  return typeof status.error === 'string' && status.error ? status.error : null;
}
