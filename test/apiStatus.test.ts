import { describe, expect, it } from 'vitest';

import { formatDuration, openAlexCheck, semanticScholarCheck } from '../src/shared/apiStatus';

const headers = (values: Record<string, string>) => ({ get: (name: string) => values[name.toLowerCase()] ?? null });

describe('paper database checks', () => {
  it('reads OpenAlex budget headers', () => {
    const ok = openAlexCheck(200, headers({ 'x-ratelimit-remaining': '312', 'x-ratelimit-limit': '1000', 'x-ratelimit-reset': '33090' }), false);
    expect(ok).toMatchObject({ state: 'ok', remaining: 312, limit: 1000 });
    expect(ok.message).toContain('312 / 1,000');
    expect(ok.message).toContain('9시간 11분 뒤 초기화');
    const spent = openAlexCheck(429, headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '1000', 'x-ratelimit-reset': '600' }), false);
    expect(spent.state).toBe('limited');
    expect(spent.message).toContain('10분 뒤 초기화');
    expect(spent.message).toContain('무료 키');
    expect(openAlexCheck(429, headers({}), true).message).toContain('이 키의 한도');
    expect(openAlexCheck(401, headers({}), true).state).toBe('bad-key');
    expect(openAlexCheck(200, headers({}), true)).toEqual({ state: 'ok', message: '키가 동작합니다' });
    expect(openAlexCheck(503, headers({}), false).state).toBe('error');
  });

  it('reads Semantic Scholar answers', () => {
    expect(semanticScholarCheck(200, true).state).toBe('ok');
    expect(semanticScholarCheck(403, true).state).toBe('bad-key');
    expect(semanticScholarCheck(429, false)).toMatchObject({ state: 'limited' });
    expect(semanticScholarCheck(500, false).state).toBe('error');
    expect(semanticScholarCheck(0, false).state).toBe('limited');
    expect(semanticScholarCheck(0, true).state).toBe('error');
  });

  it('says how long until a reset', () => {
    expect(formatDuration(30)).toBe('1분 미만');
    expect(formatDuration(600)).toBe('10분');
    expect(formatDuration(3600)).toBe('1시간');
    expect(formatDuration(3660)).toBe('1시간 1분');
  });
});
