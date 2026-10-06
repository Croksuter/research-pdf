// ─── The welcome guide, resumed after Chrome reloads the extension ───
//
// Turning on "Allow access to file URLs" on Chrome's extension page reloads
// the extension, which closes every page of it — the welcome guide too. So
// before the guide sends the user there it leaves a marker in
// chrome.storage.local; the next service-worker start (the reload) reopens
// the guide at that step and drops the marker. The guide drops it when the
// user finishes or skips; an unused marker goes stale after a few minutes.

export const WELCOME_RESUME_STORAGE_KEY = 'rpdfWelcomeResume';
/** A marker older than this is stale: the user went somewhere else. */
export const WELCOME_RESUME_MAX_AGE_MS = 10 * 60 * 1000;

export interface WelcomeResume {
  /** The step to reopen (a welcome.ts step name). */
  step: string;
  at: number;
}

export function parseWelcomeResume(value: unknown): WelcomeResume | null {
  if (typeof value !== 'object' || value === null) return null;
  const { step, at } = value as Record<string, unknown>;
  if (typeof step !== 'string' || !/^[a-z]{1,20}$/u.test(step)) return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  return { step, at };
}

/** The step to reopen the guide at, or null (no marker, or a stale one). */
export function welcomeResumeStep(value: unknown, now: number): string | null {
  const marker = parseWelcomeResume(value);
  if (!marker || marker.at > now + 60_000 || now - marker.at > WELCOME_RESUME_MAX_AGE_MS) return null;
  return marker.step;
}
