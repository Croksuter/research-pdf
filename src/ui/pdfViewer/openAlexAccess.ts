// ─── OpenAlex access: the optional API key and the daily budget ───
//
// Without a key OpenAlex counts every request against a free daily budget
// shared by everyone behind the same IP; once it is spent it answers 429
// ("Insufficient budget") until midnight UTC. A key (free, openalex.org)
// lifts that. The strip notes when the budget is spent instead of showing
// missing data as if OpenAlex had none.

import { S } from './viewerParts.strings';

let apiKey = '';
let budgetSpent = false;

export function setOpenAlexApiKey(key: string): void {
  apiKey = key.trim();
}

/** `url` with the API key, when one is set. */
export function openAlexUrl(url: string): string {
  if (!apiKey) return url;
  return `${url}${url.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(apiKey)}`;
}

export function isOpenAlexUrl(url: string): boolean {
  return url.startsWith('https://api.openalex.org/');
}

/** Called with OpenAlex's 429 body: a spent budget does not come back by retrying. */
export function noteOpenAlex429(body: string): boolean {
  if (/budget|daily/iu.test(body)) budgetSpent = true;
  return budgetSpent;
}

export function openAlexBudgetSpent(): boolean {
  return budgetSpent;
}

export const OPENALEX_BUDGET_REASON = S.openAlexBudget;
