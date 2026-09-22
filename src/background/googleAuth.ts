import { GOOGLE_DRIVE_APPDATA_SCOPE, GOOGLE_OAUTH_CLIENT_ID } from '../shared/constants';
import { CloudSyncError } from './cloudSyncError';

/**
 * Google sign-in for Drive sync.
 *
 * Security shape, deliberately narrow:
 *  - OAuth implicit flow through chrome.identity.launchWebAuthFlow. Google only
 *    delivers a token to a redirect URI registered on the client, and the
 *    browser intercepts `https://<extension-id>.chromiumapp.org/` itself, so the
 *    token never travels over the network to anything but this extension.
 *  - No client secret exists in this (public) repository and no refresh token
 *    is ever requested or stored. Access tokens live ~1 h and are cached only
 *    in chrome.storage.session (memory, cleared when the browser closes,
 *    unreadable from content scripts).
 *  - A random `state` binds each redirect to the request that started it, the
 *    granted scope is checked, and tokeninfo confirms the token was minted for
 *    this client (`aud`) before it is used.
 *  - Tokens are never logged and never placed in a URL.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKENINFO_ENDPOINT = 'https://oauth2.googleapis.com/tokeninfo';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const TOKEN_SESSION_KEY = 'vocabTGoogleAccessToken';
const REQUEST_TIMEOUT_MS = 20_000;
const SILENT_FLOW_TIMEOUT_MS = 10_000;
/** Treat a token as expired this long before Google does, to cover a slow sync. */
const EXPIRY_SKEW_MS = 5 * 60_000;
const MAX_TOKEN_CHARS = 4_096;

export type GoogleAuthFailure =
  | 'not-configured'
  | 'interaction-required'
  | 'cancelled'
  | 'denied'
  | 'failed';

export class GoogleAuthError extends CloudSyncError {
  readonly reason: GoogleAuthFailure;

  constructor(reason: GoogleAuthFailure, message: string) {
    super(message);
    this.name = 'GoogleAuthError';
    this.reason = reason;
  }
}

export interface GoogleAccessToken {
  accessToken: string;
  /** Epoch ms after which the token must not be used. */
  expiresAt: number;
}

interface CachedGoogleToken extends GoogleAccessToken {
  accountId: string;
}

export function googleClientId(): string {
  return GOOGLE_OAUTH_CLIENT_ID.trim();
}

export function isGoogleSyncConfigured(): boolean {
  return /^[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com$/u.test(googleClientId());
}

/** The exact redirect URI that must be registered on the OAuth client. */
export function googleRedirectUri(): string {
  return chrome.identity.getRedirectURL();
}

function randomState(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function buildGoogleAuthUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  interactive: boolean;
  loginHint?: string;
}): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('scope', GOOGLE_DRIVE_APPDATA_SCOPE);
  url.searchParams.set('state', options.state);
  // Interactive: always let the user pick which account holds the shared data.
  // Silent renewal: never show UI; fail with interaction_required instead.
  url.searchParams.set('prompt', options.interactive ? 'select_account' : 'none');
  if (options.loginHint) url.searchParams.set('login_hint', options.loginHint);
  return url.toString();
}

const INTERACTION_ERRORS = new Set([
  'interaction_required',
  'login_required',
  'consent_required',
  'account_selection_required',
]);

/** Validate the redirect Google sent back and extract the short-lived token. */
export function parseGoogleAuthRedirect(
  responseUrl: string | undefined,
  expected: { redirectUri: string; state: string },
  now: number = Date.now(),
): GoogleAccessToken {
  if (!responseUrl || !responseUrl.startsWith(expected.redirectUri)) {
    throw new GoogleAuthError('failed', 'Google 로그인 응답이 올바르지 않습니다.');
  }
  let params: URLSearchParams;
  try {
    const url = new URL(responseUrl);
    // Implicit flow answers in the fragment; an error may arrive in the query.
    params = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.search);
  } catch {
    throw new GoogleAuthError('failed', 'Google 로그인 응답이 올바르지 않습니다.');
  }
  // Check state before anything else: a response that is not bound to the
  // request this extension started is never trusted, not even its error code.
  if (params.get('state') !== expected.state) {
    throw new GoogleAuthError('failed', 'Google 로그인 응답을 검증하지 못했습니다.');
  }
  const error = params.get('error');
  if (error) {
    if (INTERACTION_ERRORS.has(error)) {
      throw new GoogleAuthError('interaction-required', 'Google 로그인이 만료되었습니다. 설정에서 Google 계정을 다시 연결하세요.');
    }
    if (error === 'access_denied') {
      throw new GoogleAuthError('denied', 'Google 계정 접근이 허용되지 않았습니다.');
    }
    throw new GoogleAuthError('failed', 'Google 로그인에 실패했습니다.');
  }
  const accessToken = params.get('access_token') ?? '';
  const tokenType = (params.get('token_type') ?? '').toLowerCase();
  const expiresIn = Number(params.get('expires_in'));
  const scopes = (params.get('scope') ?? '').split(/\s+/u);
  if (!accessToken || accessToken.length > MAX_TOKEN_CHARS || tokenType !== 'bearer'
    || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new GoogleAuthError('failed', 'Google 로그인 응답이 올바르지 않습니다.');
  }
  // Granular consent lets a user untick a scope; without it sync cannot work.
  if (!scopes.includes(GOOGLE_DRIVE_APPDATA_SCOPE)) {
    throw new GoogleAuthError('denied', 'Google Drive 앱 데이터 접근 권한이 허용되지 않았습니다.');
  }
  return { accessToken, expiresAt: now + expiresIn * 1_000 };
}

async function postForm(url: string, fields: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      // Form body, never a query string: tokens stay out of URLs and logs.
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    throw new GoogleAuthError('failed', 'Google 인증 서버에 연결하지 못했습니다.');
  } finally {
    clearTimeout(timeout);
  }
}

/** Confirm with Google that the token was issued to THIS client for our scope. */
async function verifyTokenAudience(token: GoogleAccessToken, clientId: string): Promise<void> {
  const response = await postForm(TOKENINFO_ENDPOINT, { access_token: token.accessToken });
  if (!response.ok) throw new GoogleAuthError('failed', 'Google 토큰을 검증하지 못했습니다.');
  let info: unknown;
  try { info = await response.json(); } catch { info = null; }
  const record = info && typeof info === 'object' ? info as Record<string, unknown> : {};
  const scopes = typeof record.scope === 'string' ? record.scope.split(/\s+/u) : [];
  if (record.aud !== clientId || !scopes.includes(GOOGLE_DRIVE_APPDATA_SCOPE)) {
    throw new GoogleAuthError('failed', 'Google 토큰을 검증하지 못했습니다.');
  }
}

/**
 * Run one OAuth round trip. `interactive: false` never shows UI and fails with
 * `interaction-required` when the Google session or consent is gone.
 */
export async function requestGoogleAccessToken(options: {
  interactive: boolean;
  loginHint?: string;
}): Promise<GoogleAccessToken> {
  if (!isGoogleSyncConfigured()) {
    throw new GoogleAuthError('not-configured', '이 빌드에는 Google 동기화가 구성되어 있지 않습니다.');
  }
  const clientId = googleClientId();
  const redirectUri = googleRedirectUri();
  const state = randomState();
  const url = buildGoogleAuthUrl({
    clientId, redirectUri, state, interactive: options.interactive, loginHint: options.loginHint,
  });
  let responseUrl: string | undefined;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow(options.interactive
      ? { url, interactive: true }
      : {
        url,
        interactive: false,
        // Google may finish a silent flow with a script redirect after load.
        abortOnLoadForNonInteractive: false,
        timeoutMsForNonInteractive: SILENT_FLOW_TIMEOUT_MS,
      });
  } catch {
    // Chrome rejects both for a closed window and for a silent flow that needed
    // UI. The rejection text is not a stable API, so classify by mode only.
    throw options.interactive
      ? new GoogleAuthError('cancelled', 'Google 로그인이 취소되었습니다.')
      : new GoogleAuthError('interaction-required', 'Google 로그인이 만료되었습니다. 설정에서 Google 계정을 다시 연결하세요.');
  }
  const token = parseGoogleAuthRedirect(responseUrl, { redirectUri, state });
  await verifyTokenAudience(token, clientId);
  return token;
}

function cachedTokenFromUnknown(value: unknown): CachedGoogleToken | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.accessToken !== 'string' || !raw.accessToken
    || typeof raw.expiresAt !== 'number' || !Number.isFinite(raw.expiresAt)
    || typeof raw.accountId !== 'string' || !raw.accountId) return null;
  return { accessToken: raw.accessToken, expiresAt: raw.expiresAt, accountId: raw.accountId };
}

/** A still-valid cached token for exactly this account, or null. */
export async function getCachedGoogleToken(accountId: string, now: number = Date.now()): Promise<GoogleAccessToken | null> {
  try {
    const stored = await chrome.storage.session.get(TOKEN_SESSION_KEY);
    const cached = cachedTokenFromUnknown(stored[TOKEN_SESSION_KEY]);
    if (!cached || cached.accountId !== accountId || cached.expiresAt - EXPIRY_SKEW_MS <= now) return null;
    return { accessToken: cached.accessToken, expiresAt: cached.expiresAt };
  } catch {
    return null;
  }
}

export async function cacheGoogleToken(accountId: string, token: GoogleAccessToken): Promise<void> {
  try {
    const value: CachedGoogleToken = { ...token, accountId };
    await chrome.storage.session.set({ [TOKEN_SESSION_KEY]: value });
  } catch {
    // The cache is an optimization; without it the next sync renews silently.
  }
}

export async function clearCachedGoogleToken(): Promise<string | null> {
  try {
    const stored = await chrome.storage.session.get(TOKEN_SESSION_KEY);
    const cached = cachedTokenFromUnknown(stored[TOKEN_SESSION_KEY]);
    await chrome.storage.session.remove(TOKEN_SESSION_KEY);
    return cached?.accessToken ?? null;
  } catch {
    return null;
  }
}

/** Best-effort server-side revocation; local sign-out never depends on it. */
export async function revokeGoogleToken(accessToken: string): Promise<void> {
  try {
    await postForm(REVOKE_ENDPOINT, { token: accessToken });
  } catch {
    // Offline sign-out still clears every local credential; the token expires
    // on its own within the hour.
  }
}
