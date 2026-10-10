// ─── Settings that follow the user (pure) ───
//
// Preferences go with the rest of the sync document (shared/pdfSync.ts,
// version 6): how tabs are named and drawn, the language, where a moved tab
// goes, the paper strip, figure capture. What belongs to one device stays
// there: API keys, Chrome's site and file access behind the "open PDFs here"
// switches, the local file cache, one PDF tab per window or per browser.
//
// Each setting carries when it was last changed on purpose (a stamp,
// `rpdfSettingAt:<key>` in chrome.storage.local, written with every change);
// a setting never changed is not sent, so a fresh device's defaults never
// override anybody's choice. The merge keeps, per key, the latest change, and
// keeps keys a newer build syncs that this one does not know.

import { isRecord } from './guards';
import { stableJson } from './threeWayMerge';

export interface SyncedSetting {
  key: string;
  value: unknown;
  updatedAt: number;
}

/** Settings in IndexedDB (db/settingsRepository.ts). */
export const SYNCED_DB_SETTINGS = ['paperInfoEnabled', 'paperStripShown', 'figureCopyOptions'] as const;
/** Settings in chrome.storage.local. */
export const SYNCED_LOCAL_SETTINGS = ['rpdfDisplay', 'rpdfLanguage', 'rpdfDragPrefs'] as const;
export type SyncedSettingKey = typeof SYNCED_DB_SETTINGS[number] | typeof SYNCED_LOCAL_SETTINGS[number];

export const SETTING_STAMP_PREFIX = 'rpdfSettingAt:';
export const settingStampKey = (key: string): string => `${SETTING_STAMP_PREFIX}${key}`;

export function isSyncedDbSetting(key: string): key is typeof SYNCED_DB_SETTINGS[number] {
  return (SYNCED_DB_SETTINGS as readonly string[]).includes(key);
}

export function isSyncedLocalSetting(key: string): key is typeof SYNCED_LOCAL_SETTINGS[number] {
  return (SYNCED_LOCAL_SETTINGS as readonly string[]).includes(key);
}

const MAX_SETTINGS = 64;
const KEY_MAX_CHARS = 64;
const VALUE_MAX_CHARS = 16_000;

/** Strict list form (sync snapshot): one bad row refuses the whole list. */
export function parseSyncedSettingList(value: unknown): SyncedSetting[] | null {
  if (!Array.isArray(value) || value.length > MAX_SETTINGS) return null;
  const seen = new Set<string>();
  const out: SyncedSetting[] = [];
  for (const row of value) {
    if (!isRecord(row) || typeof row.key !== 'string' || !row.key || row.key.length > KEY_MAX_CHARS || seen.has(row.key)) return null;
    if (typeof row.updatedAt !== 'number' || !Number.isFinite(row.updatedAt) || row.updatedAt < 0) return null;
    if (row.value === undefined || JSON.stringify(row.value).length > VALUE_MAX_CHARS) return null;
    seen.add(row.key);
    out.push({ key: row.key, value: row.value, updatedAt: row.updatedAt });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** Per key the latest change (a tie: the same pick on both sides); sorted by key. */
export function mergeSyncedSettings(left: readonly SyncedSetting[], right: readonly SyncedSetting[]): SyncedSetting[] {
  const byKey = new Map<string, SyncedSetting>();
  for (const row of [...left, ...right]) {
    const other = byKey.get(row.key);
    if (!other || row.updatedAt > other.updatedAt || (row.updatedAt === other.updatedAt && stableJson(row.value) > stableJson(other.value))) byKey.set(row.key, row);
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}
