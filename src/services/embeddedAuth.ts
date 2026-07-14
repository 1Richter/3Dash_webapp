/**
 * Embedded auth — 3Dash running inside the Home Assistant frontend.
 *
 * The companion custom panel (ha/panel.js) embeds the app in an iframe and
 * forwards the HA session's short-lived access token via postMessage. A
 * device that is already logged into Home Assistant therefore gets a fully
 * working dashboard with zero per-device setup: no token, no OAuth redirect.
 *
 * Handshake (app ⇄ parent panel):
 *   app    → parent : {type:'3dash-ready'}            on boot
 *   parent → app    : {type:'3dash-auth', hassUrl, accessToken, expiresAt}
 *   app    → parent : {type:'3dash-token-request'}    when token near expiry
 *   parent → app    : fresh '3dash-auth' message
 *
 * The first '3dash-auth' message pins the parent origin; later messages
 * from other origins are ignored.
 */

import { updateSettings } from './settingsStore';
import { getConfig, updateConfig, replaceConfig } from './configApi';

interface EmbeddedAuthState {
  hassUrl: string;
  accessToken: string;
  expiresAt: number;
  origin: string;
}

let state: EmbeddedAuthState | null = null;
let listenerInstalled = false;
const freshTokenWaiters: Array<() => void> = [];
const authListeners: Array<() => void> = [];

/**
 * Subscribe to embedded-auth arrival (fires on every auth message, including
 * ones that arrive after the boot handshake timed out). Returns unsubscribe.
 */
export function onEmbeddedAuth(cb: () => void): () => void {
  installListener();
  authListeners.push(cb);
  return () => {
    const i = authListeners.indexOf(cb);
    if (i >= 0) authListeners.splice(i, 1);
  };
}

export function isEmbedded(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true; // cross-origin parent → definitely embedded
  }
}

function installListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  window.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: string; hassUrl?: string; accessToken?: string; expiresAt?: number } | null;
    if (!d || d.type !== '3dash-auth') return;
    if (e.source !== window.parent) return;
    if (typeof d.hassUrl !== 'string' || typeof d.accessToken !== 'string') return;
    // Pin the origin of the first auth message; ignore other senders after that
    if (state && e.origin !== state.origin) return;
    state = {
      hassUrl: d.hassUrl.replace(/\/+$/, ''),
      accessToken: d.accessToken,
      expiresAt: typeof d.expiresAt === 'number' ? d.expiresAt : Date.now() + 15 * 60_000,
      origin: e.origin,
    };
    while (freshTokenWaiters.length) freshTokenWaiters.shift()!();
    for (const cb of [...authListeners]) cb();
  });
}

/** True once the parent panel has delivered a token. */
export function hasEmbeddedAuth(): boolean {
  return state !== null;
}

/**
 * Announce readiness to a potential parent panel and wait briefly for a
 * token. Resolves false when not iframed or when no panel answers (plain
 * iframe embeds without the companion panel).
 */
export async function initEmbeddedAuth(timeoutMs = 1500): Promise<boolean> {
  if (!isEmbedded()) return false;
  installListener();
  window.parent.postMessage({ type: '3dash-ready' }, '*');
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    freshTokenWaiters.push(() => { clearTimeout(t); resolve(); });
  });
  if (state === null) {
    // Parent may still be booting (slow mobile, hass not set yet) — keep
    // announcing for a while; late auth is delivered via onEmbeddedAuth().
    let attempts = 0;
    const timer = setInterval(() => {
      if (state !== null || ++attempts > 15) { clearInterval(timer); return; }
      window.parent.postMessage({ type: '3dash-ready' }, '*');
    }, 2000);
  }
  return state !== null;
}

/** Token provider for HAConnection — asks the parent for a fresh token when needed. */
export async function getEmbeddedAccessToken(): Promise<string> {
  if (!state) throw new Error('No embedded Home Assistant session');
  if (Date.now() < state.expiresAt - 30_000) return state.accessToken;
  window.parent.postMessage({ type: '3dash-token-request' }, state.origin);
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 3000); // best effort — fall back to the old token
    freshTokenWaiters.push(() => { clearTimeout(t); resolve(); });
  });
  return state.accessToken;
}

/**
 * Configure this browser for HA-hosted sync based on the embedded session.
 * Safe to run on every boot: an empty stub config keeps updatedAt 0 so the
 * remote config always wins the first sync.
 */
export function configureFromEmbeddedAuth(): void {
  if (!state) return;
  const u = new URL(state.hassUrl);
  updateSettings('connection', {
    haSettings: {
      url: u.hostname,
      port: u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80),
      token: '', // embedded devices authenticate via getEmbeddedAccessToken()
    },
  });
  updateSettings('sync', { autoSync: true, modelSource: 'ha', modelName: 'model' });
  const cfg = getConfig();
  if (!cfg.onboarding?.completed) {
    updateConfig({
      onboarding: { completed: true },
      location: cfg.location ?? { latitude: 51.0, longitude: 10.0 },
    });
    replaceConfig({ ...getConfig(), updatedAt: 0 });
  }
}
