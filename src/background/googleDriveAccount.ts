import { CloudSyncError } from './cloudSyncError';
import {
  GoogleAuthError,
  cacheGoogleToken,
  clearCachedGoogleToken,
  getCachedGoogleToken,
  requestGoogleAccessToken,
  revokeGoogleToken,
} from './googleAuth';
import { DriveAccount, GoogleDriveStore, createGoogleDriveStore } from './googleDriveStore';

/**
 * The connected Google account, as each sync engine stores it: the Drive
 * `permissionId` pins the account, the email is only a display value and the
 * silent-renewal hint.
 */
export interface GoogleAccountRef {
  id: string;
  email: string;
}

/**
 * A token for exactly the connected account. Renewal is silent; when Google
 * needs the user again this fails and the popup asks them to reconnect.
 */
export async function accessTokenForAccount(account: GoogleAccountRef, forceRefresh: boolean, files = false): Promise<string> {
  if (forceRefresh) await clearCachedGoogleToken();
  const cached = forceRefresh ? null : await getCachedGoogleToken(account.id, Date.now(), files);
  if (cached) return cached.accessToken;
  const token = await requestGoogleAccessToken({
    interactive: false,
    loginHint: account.email || undefined,
    files,
  }).catch((error: unknown) => {
    // Asked silently for the PDF files and Google wants the user: grant it again.
    throw files && error instanceof GoogleAuthError && error.reason === 'interaction-required' ? new CloudSyncError('files-consent') : error;
  });
  // PDF files asked for, not granted (consent withdrawn): the user has to grant it again.
  if (files && !token.files) throw new CloudSyncError('files-consent');
  // A silent flow can answer for whichever Google session the browser prefers.
  // Never sync one account's data into another account's Drive.
  const actual = await createGoogleDriveStore(async () => token.accessToken).account();
  if (actual.id !== account.id) {
    await revokeGoogleToken(token.accessToken);
    throw new CloudSyncError('account-mismatch');
  }
  await cacheGoogleToken(account.id, token);
  return token.accessToken;
}

/**
 * Interactive consent for the PDF files (`drive.file`) on top of the
 * connected account's sync, for exactly that account.
 */
export async function grantDriveFiles(account: GoogleAccountRef): Promise<void> {
  const token = await requestGoogleAccessToken({ interactive: true, loginHint: account.email || undefined, files: true });
  const actual = await createGoogleDriveStore(async () => token.accessToken).account().catch(async (error: unknown) => {
    await revokeGoogleToken(token.accessToken);
    throw error;
  });
  if (actual.id !== account.id) {
    await revokeGoogleToken(token.accessToken);
    throw new CloudSyncError('account-mismatch');
  }
  if (!token.files) throw new CloudSyncError('files-consent');
  await cacheGoogleToken(account.id, token);
}

export function driveStoreForAccount(account: GoogleAccountRef, fileName?: string): GoogleDriveStore {
  return createGoogleDriveStore((forceRefresh) => accessTokenForAccount(account, forceRefresh), fileName);
}

/**
 * Interactive sign-in. Runs in the service worker because a popup closes as
 * soon as the account window takes focus. Returns the pinned account and
 * leaves its token cached for the first sync.
 */
export async function connectGoogleAccount(): Promise<DriveAccount> {
  const token = await requestGoogleAccessToken({ interactive: true });
  let account: DriveAccount;
  try {
    account = await createGoogleDriveStore(async () => token.accessToken).account();
  } catch (error) {
    await revokeGoogleToken(token.accessToken);
    throw error;
  }
  await cacheGoogleToken(account.id, token);
  return account;
}

/** Drop the cached token and revoke it server-side (best effort). */
export async function disconnectGoogleAccount(): Promise<void> {
  const accessToken = await clearCachedGoogleToken();
  if (accessToken) await revokeGoogleToken(accessToken);
}
