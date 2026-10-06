// ─── Paper database checks for the settings page (pure) ───
//
// "확인" on the settings page sends one request to each database and reads
// the answer here: does the key work, and how much of the day's budget is
// left. OpenAlex reports its budget in X-RateLimit-* headers (exposed to
// CORS): keyless use shares a small daily budget per IP address, reset at
// midnight UTC. Semantic Scholar has no budget headers; a 429 means its
// shared keyless pool is busy.

import { currentLanguage } from './i18n';
import { S } from './apiStatus.strings';

export type ApiCheckState = 'ok' | 'limited' | 'bad-key' | 'error';

export interface ApiCheck {
  state: ApiCheckState;
  message: string;
  remaining?: number;
  limit?: number;
}

interface HeaderSource { get(name: string): string | null }

function count(value: string | null): number | null {
  if (value === null || !/^\d+(?:\.\d+)?$/u.test(value.trim())) return null;
  return Number(value);
}

/** "3시간 12분" / "12분" / "1분 미만". */
export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return S.underMinute;
  const hours = Math.floor(minutes / 60);
  if (hours < 1) return S.minutes(minutes);
  return minutes % 60 ? S.hoursMinutes(hours, minutes % 60) : S.hours(hours);
}

export function openAlexCheck(status: number, headers: HeaderSource, hasKey: boolean): ApiCheck {
  const remaining = count(headers.get('x-ratelimit-remaining'));
  const limit = count(headers.get('x-ratelimit-limit'));
  const reset = count(headers.get('x-ratelimit-reset'));
  const resetText = reset !== null ? S.resetsIn(formatDuration(reset)) : '';
  const budget = remaining !== null && limit !== null ? S.budget(remaining.toLocaleString(currentLanguage()), limit.toLocaleString(currentLanguage())) : null;
  const numbers = { ...(remaining !== null ? { remaining } : {}), ...(limit !== null ? { limit } : {}) };
  if (status === 401 || status === 403) return { state: 'bad-key', message: S.oaBadKey };
  if (status === 429) {
    return {
      state: 'limited',
      message: hasKey ? S.oaKeyLimit(resetText) : S.oaNoKeyLimit(resetText),
      ...numbers,
    };
  }
  if (status >= 200 && status < 300) {
    const who = hasKey ? S.oaWorksKey : S.oaWorksNoKey;
    return { state: 'ok', message: [who, budget].filter(Boolean).join(' · ') + resetText, ...numbers };
  }
  return { state: 'error', message: S.oaNoAnswer(status) };
}

/** `status` 0: no answer the page could read (offline, or a 429, which comes without CORS headers). */
export function semanticScholarCheck(status: number, hasKey: boolean): ApiCheck {
  if (status === 0) {
    return hasKey
      ? { state: 'error', message: S.s2NoAnswerKey }
      : { state: 'limited', message: S.s2NoAnswerNoKey };
  }
  if (status === 401 || status === 403) return { state: 'bad-key', message: S.s2BadKey };
  if (status === 429) {
    return {
      state: 'limited',
      message: hasKey ? S.s2LimitKey : S.s2LimitNoKey,
    };
  }
  if (status >= 200 && status < 300) return { state: 'ok', message: hasKey ? S.s2WorksKey : S.s2WorksNoKey };
  return { state: 'error', message: S.s2NoAnswer(status) };
}
