// ─── Paper database checks for the settings page (pure) ───
//
// "확인" on the settings page sends one request to each database and reads
// the answer here: does the key work, and how much of the day's budget is
// left. OpenAlex reports its budget in X-RateLimit-* headers (exposed to
// CORS): keyless use shares a small daily budget per IP address, reset at
// midnight UTC. Semantic Scholar has no budget headers; a 429 means its
// shared keyless pool is busy.

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
  if (minutes < 1) return '1분 미만';
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}시간${minutes % 60 ? ` ${minutes % 60}분` : ''}` : `${minutes}분`;
}

export function openAlexCheck(status: number, headers: HeaderSource, hasKey: boolean): ApiCheck {
  const remaining = count(headers.get('x-ratelimit-remaining'));
  const limit = count(headers.get('x-ratelimit-limit'));
  const reset = count(headers.get('x-ratelimit-reset'));
  const resetText = reset !== null ? ` · ${formatDuration(reset)} 뒤 초기화` : '';
  const budget = remaining !== null && limit !== null ? `오늘 남은 요청 ${remaining.toLocaleString('ko-KR')} / ${limit.toLocaleString('ko-KR')}` : null;
  const numbers = { ...(remaining !== null ? { remaining } : {}), ...(limit !== null ? { limit } : {}) };
  if (status === 401 || status === 403) return { state: 'bad-key', message: 'OpenAlex가 이 키를 받지 않습니다. 키를 다시 확인하세요.' };
  if (status === 429) {
    return {
      state: 'limited',
      message: hasKey
        ? `이 키의 한도를 다 썼습니다${resetText}.`
        : `이 네트워크의 키 없는 일일 한도를 다 썼습니다${resetText}. 무료 키를 넣으면 따로 한도를 받습니다.`,
      ...numbers,
    };
  }
  if (status >= 200 && status < 300) {
    const who = hasKey ? '키가 동작합니다' : '키 없이 동작합니다 (네트워크 공용 한도)';
    return { state: 'ok', message: [who, budget].filter(Boolean).join(' · ') + resetText, ...numbers };
  }
  return { state: 'error', message: `OpenAlex가 응답하지 않습니다 (HTTP ${status}).` };
}

/** `status` 0: no answer the page could read (offline, or a 429, which comes without CORS headers). */
export function semanticScholarCheck(status: number, hasKey: boolean): ApiCheck {
  if (status === 0) {
    return hasKey
      ? { state: 'error', message: '응답을 받지 못했습니다. 네트워크를 확인하거나 잠시 뒤 다시 확인하세요.' }
      : { state: 'limited', message: '응답을 받지 못했습니다. 키 없는 공용 한도가 붐빌 때 흔히 이렇습니다. 잠시 뒤 다시 확인하거나 키를 넣으세요.' };
  }
  if (status === 401 || status === 403) return { state: 'bad-key', message: 'Semantic Scholar가 이 키를 받지 않습니다. 키를 다시 확인하세요.' };
  if (status === 429) {
    return {
      state: 'limited',
      message: hasKey
        ? '요청 제한에 걸렸습니다. 잠시 뒤 다시 시도하세요.'
        : '키 없는 공용 한도가 지금 붐빕니다(429). 키를 넣으면 안정적으로 조회됩니다.',
    };
  }
  if (status >= 200 && status < 300) return { state: 'ok', message: hasKey ? '키가 동작합니다.' : '키 없이 동작합니다 (공용 한도, 붐비면 실패할 수 있음).' };
  return { state: 'error', message: `Semantic Scholar가 응답하지 않습니다 (HTTP ${status}).` };
}
