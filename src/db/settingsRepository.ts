import { STORE_SETTINGS } from '../shared/constants';
import { isSyncedDbSetting, settingStampKey } from '../shared/syncedSettings';
import { dbPut, dbGet } from './database';

interface SettingRecord {
  key: string;
  value: unknown;
}

export async function getSetting<T>(key: string, defaultValue: T): Promise<T> {
  const record = await dbGet<SettingRecord>(STORE_SETTINGS, key);
  return record ? (record.value as T) : defaultValue;
}

/** Stores a setting; one that syncs (shared/syncedSettings.ts) is stamped as changed now. */
export async function setSetting<T>(key: string, value: T): Promise<void> {
  await dbPut<SettingRecord>(STORE_SETTINGS, { key, value });
  if (isSyncedDbSetting(key) && typeof chrome !== 'undefined' && chrome.storage?.local) {
    try { await chrome.storage.local.set({ [settingStampKey(key)]: Date.now() }); } catch { /* not synced as changed */ }
  }
}
