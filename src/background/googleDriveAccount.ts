import { CloudSyncError } from './cloudSyncError';
import {
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
export async function accessTokenForAccount(account: GoogleAccountRef, forceRefresh: boolean): Promise<string> {
  if (forceRefresh) await clearCachedGoogleToken();
  const cached = forceRefresh ? null : await getCachedGoogleToken(account.id);
  if (cached) return cached.accessToken;
  const token = await requestGoogleAccessToken({
    interactive: false,
    loginHint: account.email || undefined,
  });
  // A silent flow can answer for whichever Google session the browser prefers.
  // Never sync one account's data into another account's Drive.
  const actual = await createGoogleDriveStore(async () => token.accessToken).account();
  if (actual.id !== account.id) {
    await revokeGoogleToken(token.accessToken);
    throw new CloudSyncError('연결된 Google 계정과 다른 계정으로 로그인되어 있습니다. 설정에서 다시 연결하세요.');
  }
  await cacheGoogleToken(account.id, token);
  return token.accessToken;
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
