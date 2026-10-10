// ─── Which projects keep their PDF files in the user's Drive (pure) ───
//
// Per project, separately for local files and web PDFs: when a document of
// that project opens, its file goes to the Drive folder
// (background/pdfDriveFiles.ts). A synced setting (shared/syncedSettings.ts),
// so the rule is the same on every device.

import { isRecord } from './guards';

export const DRIVE_AUTO_STORAGE_KEY = 'rpdfDriveAuto';

export type DriveAutoRules = Record<string, { local: boolean; web: boolean }>;

export function parseDriveAutoRules(value: unknown): DriveAutoRules {
  const out: DriveAutoRules = {};
  if (!isRecord(value)) return out;
  for (const [id, rule] of Object.entries(value).slice(0, 500)) {
    if (id.length <= 64 && isRecord(rule) && (rule.local === true || rule.web === true)) out[id] = { local: rule.local === true, web: rule.web === true };
  }
  return out;
}

/** Whether a document of these projects (none: the default project) is kept: `local` for a file from disk. */
export function driveAutoWants(rules: DriveAutoRules, projectIds: readonly string[], local: boolean): boolean {
  return projectIds.some((id) => (local ? rules[id]?.local : rules[id]?.web) === true);
}
