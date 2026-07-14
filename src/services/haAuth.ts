/**
 * "Sign in with Home Assistant" — OAuth2 (IndieAuth) device authorization.
 *
 * Instead of pasting a long-lived token on every device, the user clicks a
 * login button, approves the app on their HA login screen (usually already
 * signed in), and gets short-lived access tokens with a refresh token stored
 * locally. HA remains the single source of truth: after sign-in the device
 * pulls config + model from HA automatically.
 *
 * Flow:
 *  1. startOAuthLogin(hassUrl) → full-page redirect to {hass}/auth/authorize
 *  2. HA redirects back to {origin}/?code=...&state=...
 *  3. completeOAuthLogin() (called at app boot) exchanges the code for tokens,
 *     saves them, and configures the device for HA-hosted config/model sync.
 *  4. getOAuthAccessToken() hands the WebSocket a valid token, refreshing it
 *     via the refresh token when expired.
 */

import { updateSettings } from './settingsStore';
import { getConfig, updateConfig, replaceConfig } from './configApi';

const STORAGE_KEY = 'haOAuth';

interface StoredOAuth {
  hassUrl: string;       // e.g. https://homeassistant.example.net
  accessToken: string;
  refreshToken: string;
  expiresAt: number;     // epoch ms
}

function clientId(): string {
  // IndieAuth: the client_id is the app's own URL; redirect_uri must share its host.
  return window.location.origin + '/';
}

export function getStoredOAuth(): StoredOAuth | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredOAuth) : null;
  } catch {
    return null;
  }
}

function saveOAuth(t: StoredOAuth): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
}

export function clearOAuth(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Whether this device is signed in via OAuth (vs. a long-lived token). */
export function hasOAuth(): boolean {
  return getStoredOAuth() !== null;
}

/** Normalize user input ("host", "host:port", "https://host") to a base URL. */
export function normalizeHassUrl(input: string, port?: number): string {
  let url = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) {
    const proto = window.location.protocol === 'https:' ? 'https' : 'http';
    const defaultPort = proto === 'https' ? 443 : 8123;
    const p = port ?? defaultPort;
    const needsPort = !(proto === 'https' && p === 443) && !(proto === 'http' && p === 80);
    url = `${proto}://${url}${needsPort ? `:${p}` : ''}`;
  }
  return url;
}

/** If the app runs inside an iframe (e.g. a HA dashboard card), suggest the parent's host. */
export function referrerHassHost(): string {
  try {
    if (window.self !== window.top && document.referrer) {
      return new URL(document.referrer).hostname;
    }
  } catch { /* cross-origin access denied — fine */ }
  return '';
}

/** Full-page redirect to Home Assistant's authorize screen. */
export function startOAuthLogin(hassUrlInput: string, port?: number): void {
  const hassUrl = normalizeHassUrl(hassUrlInput, port);
  const state = btoa(JSON.stringify({ hassUrl }));
  const url =
    `${hassUrl}/auth/authorize` +
    `?client_id=${encodeURIComponent(clientId())}` +
    `&redirect_uri=${encodeURIComponent(clientId())}` +
    `&state=${encodeURIComponent(state)}`;
  // '_top' breaks out of an embedding iframe (HA login refuses to render framed)
  window.open(url, '_top');
}

/**
 * Handle the OAuth redirect at app boot. Returns true when a login was
 * completed (tokens saved + device configured for HA sync), false when the
 * URL carries no auth code.
 */
export async function completeOAuthLogin(): Promise<boolean> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return false;

  let hassUrl: string;
  try {
    hassUrl = (JSON.parse(atob(state)) as { hassUrl: string }).hassUrl;
  } catch {
    return false; // not our state parameter
  }

  const resp = await fetch(`${hassUrl}/auth/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId(),
    }),
  });
  if (!resp.ok) {
    throw new Error(`Home Assistant token exchange failed (HTTP ${resp.status})`);
  }
  const data = await resp.json() as { access_token: string; refresh_token: string; expires_in: number };
  saveOAuth({
    hassUrl,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });

  // Configure this device: connect to HA, sync config + model from HA
  const u = new URL(hassUrl);
  updateSettings('connection', {
    haSettings: {
      url: u.hostname,
      port: u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80),
      token: '', // OAuth devices use getOAuthAccessToken() instead
    },
  });
  updateSettings('sync', { autoSync: true, modelSource: 'ha', modelName: 'model' });
  const cfg = getConfig();
  updateConfig({
    onboarding: { completed: true },
    location: cfg.location ?? { latitude: 51.0, longitude: 10.0 },
  });
  // Zero the timestamp: this device starts empty, so any remote config
  // must win the first sync instead of being clobbered by this stub.
  replaceConfig({ ...getConfig(), updatedAt: 0 });

  // Remove ?code=&state= so a reload doesn't retry the (single-use) code
  window.history.replaceState({}, '', window.location.pathname + window.location.hash);
  return true;
}

/** Return a valid access token, refreshing it when (nearly) expired. */
export async function getOAuthAccessToken(): Promise<string> {
  const stored = getStoredOAuth();
  if (!stored) throw new Error('Not signed in with Home Assistant');
  if (Date.now() < stored.expiresAt - 60_000) return stored.accessToken;

  const resp = await fetch(`${stored.hassUrl}/auth/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken,
      client_id: clientId(),
    }),
  });
  if (!resp.ok) {
    if (resp.status === 400 || resp.status === 401) clearOAuth(); // refresh token revoked
    throw new Error(`Home Assistant token refresh failed (HTTP ${resp.status})`);
  }
  const data = await resp.json() as { access_token: string; expires_in: number };
  saveOAuth({
    ...stored,
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
  return data.access_token;
}
