// ─── Synced settings on this device: read, stamp, apply ───
//
// The preferences shared/syncedSettings.ts lists, as the sync document
// carries them. A change made here is stamped as it is stored (IndexedDB
// ones by db/settingsRepository.ts, chrome.storage.local ones by the
// listener below) and asks for a push; one that came from another device is
// stored with that device's stamp, so it is not sent back as new.

import { dbGet, dbPut } from '../db/database';
import { STORE_SETTINGS } from '../shared/constants';
import { parseDisplayPrefs } from '../shared/displayPrefs';
import { FIGURE_COPY_OPTIONS_CHANNEL, normalizeFigureCopyOptions } from '../shared/figureSource';
import { parseLanguagePref } from '../shared/i18n';
import { parseDragPrefs } from '../shared/tabTransfer';
import {
  SYNCED_DB_SETTINGS,
  SYNCED_LOCAL_SETTINGS,
  type SyncedSetting,
  isSyncedDbSetting,
  isSyncedLocalSetting,
  settingStampKey,
} from '../shared/syncedSettings';

const ALL_KEYS: readonly string[] = [...SYNCED_DB_SETTINGS, ...SYNCED_LOCAL_SETTINGS];

/** Stamps being written by `applySyncedSettings`: not a change made here. */
const applying = new Map<string, number>();

/** The value as this build stores it, or undefined when it cannot be. */
function normalize(key: string, value: unknown): unknown {
  switch (key) {
    case 'paperInfoEnabled':
    case 'paperStripShown': return typeof value === 'boolean' ? value : undefined;
    case 'figureCopyOptions': return normalizeFigureCopyOptions(value);
    case 'rpdfDisplay': return parseDisplayPrefs(value);
    case 'rpdfLanguage': return parseLanguagePref(value);
    case 'rpdfDragPrefs': return parseDragPrefs(value);
    default: return undefined;
  }
}

/** The settings changed on purpose, on this device or synced to it. */
export async function readSyncedSettings(): Promise<SyncedSetting[]> {
  const stored = await chrome.storage.local.get([...SYNCED_LOCAL_SETTINGS, ...ALL_KEYS.map(settingStampKey)]);
  const out: SyncedSetting[] = [];
  for (const key of ALL_KEYS) {
    const updatedAt = stored[settingStampKey(key)];
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) continue;
    const value = isSyncedLocalSetting(key) ? stored[key] : (await dbGet<{ value: unknown }>(STORE_SETTINGS, key))?.value;
    if (value !== undefined) out.push({ key, value, updatedAt });
  }
  return out;
}

/** Stores what another device changed later than this one did. Keys this build does not know are left to the document. */
export async function applySyncedSettings(rows: readonly SyncedSetting[]): Promise<void> {
  const stamps = await chrome.storage.local.get(ALL_KEYS.map(settingStampKey));
  for (const row of rows) {
    if (!isSyncedDbSetting(row.key) && !isSyncedLocalSetting(row.key)) continue;
    const stampKey = settingStampKey(row.key);
    const local = stamps[stampKey];
    if (typeof local === 'number' && local >= row.updatedAt) continue;
    const value = normalize(row.key, row.value);
    if (value === undefined) continue;
    applying.set(stampKey, row.updatedAt);
    if (isSyncedDbSetting(row.key)) {
      await dbPut(STORE_SETTINGS, { key: row.key, value });
      await chrome.storage.local.set({ [stampKey]: row.updatedAt });
      // Open viewers take capture options from their channel.
      if (row.key === 'figureCopyOptions') {
        const channel = new BroadcastChannel(FIGURE_COPY_OPTIONS_CHANNEL);
        channel.postMessage(value);
        channel.close();
      }
    } else {
      await chrome.storage.local.set({ [row.key]: value, [stampKey]: row.updatedAt });
    }
  }
}

/** Stamps chrome.storage.local settings as they change here, and calls `onChange` for every change made here. */
export function watchSyncedSettings(onChange: () => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const stamps: Record<string, number> = {};
    for (const key of SYNCED_LOCAL_SETTINGS) {
      if (changes[key] && !changes[settingStampKey(key)]) stamps[settingStampKey(key)] = Date.now();
    }
    let changedHere = Object.keys(stamps).length > 0;
    if (changedHere) void chrome.storage.local.set(stamps);
    for (const key of ALL_KEYS) {
      const stampKey = settingStampKey(key);
      const change = changes[stampKey];
      if (!change || stamps[stampKey] !== undefined) continue;
      if (applying.get(stampKey) === change.newValue) { applying.delete(stampKey); continue; }
      changedHere = true;
    }
    if (changedHere) onChange();
  });
}
