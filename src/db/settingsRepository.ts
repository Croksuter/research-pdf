import { STORE_SETTINGS } from '../shared/constants';
import { dbPut, dbGet } from './database';

interface SettingRecord {
  key: string;
  value: unknown;
}

export async function getSetting<T>(key: string, defaultValue: T): Promise<T> {
  const record = await dbGet<SettingRecord>(STORE_SETTINGS, key);
  return record ? (record.value as T) : defaultValue;
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  await dbPut<SettingRecord>(STORE_SETTINGS, { key, value });
}
