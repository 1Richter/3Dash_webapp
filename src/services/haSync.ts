/**
 * Cross-device sync of the 3Dash config and 3D model, using only
 * HA-native storage (Issue #8) — no external backend, no GitHub tokens.
 *
 * Config  → shared across ALL HA users via a hidden storage-mode Lovelace
 *           dashboard ("three-dash-data"): admins write it with
 *           `lovelace/config/save`, every signed-in user can read it with
 *           `lovelace/config`. Persisted by HA in .storage and included in HA
 *           backups. The old per-user store (`frontend/get_user_data`, key
 *           "3dash_config") is still read as a fallback and mirrored on every
 *           push, so existing installs migrate automatically.
 *
 * Model   → served from HA's `config/www` directory as
 *           `http(s)://<ha>:<port>/local/3dash/<name>.glb` (unauthenticated,
 *           correct `model/gltf-binary` MIME, ETag support — verified live).
 *           The file is cached in IndexedDB and only re-downloaded when the
 *           ETag changes, so startup stays instant and works offline.
 *
 * Conflict resolution: last-writer-wins on AppConfig.updatedAt.
 */

import type { AppConfig } from '../types';
import { getActiveHAConnection } from './haWebSocket';
import { getSetting } from './settingsStore';
import { getCachedUser } from './haUser';
import { saveModel, getModel, saveMeta, getMeta } from './storageApi';

const USER_DATA_KEY = '3dash_config';
/** url_path of the hidden storage dashboard that holds the shared config. */
const SHARED_DASHBOARD_PATH = 'three-dash-data';
const PUSH_DEBOUNCE_MS = 2500;

export type SyncStatus = 'idle' | 'pushing' | 'pulling' | 'synced' | 'error' | 'offline';

let statusListener: ((s: SyncStatus, detail?: string) => void) | null = null;
export function setSyncStatusListener(fn: ((s: SyncStatus, detail?: string) => void) | null): void {
  statusListener = fn;
}
function report(s: SyncStatus, detail?: string): void {
  statusListener?.(s, detail);
}

/* ── Config sync via frontend user_data ── */

interface RemoteEnvelope {
  config: AppConfig;
  updatedAt: number;
  device: string;
}

function isSyncEnabled(): boolean {
  return getSetting('sync').autoSync;
}

function validEnvelope(env: RemoteEnvelope | null | undefined): RemoteEnvelope | null {
  return env && typeof env.updatedAt === 'number' && env.config ? env : null;
}

/** Set when the last pull found no shared store (fresh install / pre-shared
 *  version) — syncOnConnect then seeds it from whatever config wins. */
let sharedStoreMissing = false;

interface HAConn { request(msg: Record<string, unknown>): Promise<unknown>; }

async function pullSharedEnvelope(ha: HAConn): Promise<RemoteEnvelope | null> {
  try {
    const cfg = await ha.request({ type: 'lovelace/config', url_path: SHARED_DASHBOARD_PATH }) as
      { threeDash?: RemoteEnvelope } | null;
    const env = validEnvelope(cfg?.threeDash);
    if (env) {
      sharedStoreMissing = false;
      return env;
    }
  } catch {
    // Dashboard or its config doesn't exist yet
  }
  sharedStoreMissing = true;
  return null;
}

let dashboardEnsured = false;

/** Create the hidden storage dashboard on first push (idempotent, admin-only). */
async function ensureSharedDashboard(ha: HAConn): Promise<void> {
  if (dashboardEnsured) return;
  const dashboards = await ha.request({ type: 'lovelace/dashboards/list' }) as
    Array<{ url_path: string }>;
  if (!dashboards.some((d) => d.url_path === SHARED_DASHBOARD_PATH)) {
    await ha.request({
      type: 'lovelace/dashboards/create',
      url_path: SHARED_DASHBOARD_PATH,
      mode: 'storage',
      title: '3Dash Data',
      icon: 'mdi:cube-outline',
      show_in_sidebar: false,
      require_admin: false,
    });
  }
  dashboardEnsured = true;
}

/**
 * Read the remote config envelope from HA: the shared store first, then the
 * legacy per-user store as a migration fallback. Returns null when neither
 * has one.
 */
export async function pullRemoteConfig(): Promise<RemoteEnvelope | null> {
  const ha = getActiveHAConnection();
  if (!ha?.isConnected) return null;
  const shared = await pullSharedEnvelope(ha);
  if (shared) return shared;
  const res = await ha.request({ type: 'frontend/get_user_data', key: USER_DATA_KEY }) as
    { value?: RemoteEnvelope | null } | null;
  return validEnvelope(res?.value);
}

/**
 * Write the given config to HA. Admins write the shared store (and mirror to
 * their per-user store for older installs); non-admin sessions are read-only
 * for the shared config, so their local-only tweaks are not published.
 */
export async function pushConfigToHA(config: AppConfig): Promise<void> {
  const ha = getActiveHAConnection();
  if (!ha?.isConnected) {
    report('offline');
    return;
  }
  const user = getCachedUser();
  if (user && !user.isAdmin) {
    report('synced');
    return;
  }
  report('pushing');
  const envelope: RemoteEnvelope = {
    config,
    updatedAt: config.updatedAt ?? Date.now(),
    device: navigator.userAgent.slice(0, 80),
  };
  await ensureSharedDashboard(ha);
  await ha.request({
    type: 'lovelace/config/save',
    url_path: SHARED_DASHBOARD_PATH,
    config: { views: [], threeDash: envelope },
  });
  sharedStoreMissing = false;
  await ha.request({ type: 'frontend/set_user_data', key: USER_DATA_KEY, value: envelope });
  report('synced');
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Debounced push — call after every local config mutation. Rapid edits
 * (e.g. dragging a light) collapse into a single WS write.
 */
export function schedulePush(getLatest: () => AppConfig): void {
  if (!isSyncEnabled()) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushConfigToHA(getLatest()).catch((e) => {
      console.warn('[haSync] push failed:', e);
      report('error', String(e));
    });
  }, PUSH_DEBOUNCE_MS);
}

export interface SyncResult {
  action: 'pulled' | 'pushed' | 'in-sync' | 'disabled' | 'offline';
  remoteConfig?: AppConfig;
}

/**
 * Reconcile local and remote config after the HA connection comes up.
 * Newer `updatedAt` wins. Returns the remote config when it superseded
 * the local one so the caller can apply it and rebuild the scene.
 */
export async function syncOnConnect(local: AppConfig): Promise<SyncResult> {
  if (!isSyncEnabled()) return { action: 'disabled' };
  const ha = getActiveHAConnection();
  if (!ha?.isConnected) return { action: 'offline' };

  report('pulling');
  const remote = await pullRemoteConfig();
  const localTs = local.updatedAt ?? 0;

  // Safety net: a device with no content (fresh /connect or new sign-in)
  // must never overwrite a configured remote, whatever the timestamps say.
  const localEmpty = !local.lights?.length && !local.displays?.length
    && !local.tubes?.length && !local.zones?.length;
  const remoteHasContent = !!(remote && (remote.config.lights?.length
    || remote.config.displays?.length || remote.config.tubes?.length
    || remote.config.zones?.length));
  // Migration: the winning config also seeds the shared store when the pull
  // had to fall back to the legacy per-user store (no-op for non-admins).
  const seedShared = (cfg: AppConfig) => {
    if (sharedStoreMissing) {
      pushConfigToHA(cfg).catch((e) => console.warn('[haSync] shared-store seed failed:', e));
    }
  };

  if (localEmpty && remoteHasContent) {
    seedShared(remote!.config);
    report('synced');
    return { action: 'pulled', remoteConfig: remote!.config };
  }

  if (!remote || remote.updatedAt < localTs) {
    // Local is newer (or remote empty) → publish local
    await pushConfigToHA(local);
    return { action: 'pushed' };
  }
  if (remote.updatedAt === localTs) {
    seedShared(local);
    report('synced');
    return { action: 'in-sync' };
  }
  // Remote is newer → hand it to the caller
  seedShared(remote.config);
  report('synced');
  return { action: 'pulled', remoteConfig: remote.config };
}

/* ── Model sync via /local/ (config/www) ── */

/** Base URL of the HA instance derived from connection settings. */
function haHttpBase(): string {
  const { url, port } = getSetting('connection').haSettings;
  const proto = window.location.protocol === 'https:' ? 'https' : 'http';
  return `${url.startsWith('http') ? url : `${proto}://${url}`}:${port}`;
}

/** Public URL of a model hosted in HA's config/www/3dash directory. */
export function haModelUrl(name = 'model'): string {
  return `${haHttpBase()}/local/3dash/${name}.glb`;
}

/**
 * Fetch a model from HA's www directory, using the IndexedDB copy as a cache.
 * HA serves /local/ with a 31-day Cache-Control but honours ETag revalidation,
 * so we bypass the HTTP cache and do our own conditional fetch.
 *
 * Returns the blob, or the cached copy when HA is unreachable (offline-first),
 * or null when neither exists.
 */
export async function fetchModelFromHA(name = 'model'): Promise<Blob | null> {
  const url = haModelUrl(name);
  const cacheKey = `ha:${name}`;
  const cached = await getModel(cacheKey);
  const cachedEtag = cached ? await getMeta(cacheKey) : null;

  try {
    const headers: Record<string, string> = {};
    if (cachedEtag) headers['If-None-Match'] = cachedEtag;
    const resp = await fetch(url, { headers, cache: 'no-cache' });

    if (resp.status === 304 && cached) return cached;
    if (!resp.ok) {
      console.warn(`[haSync] model fetch ${resp.status} for ${url}`);
      return cached; // fall back to cache (e.g. 404 after file removed)
    }
    const blob = await resp.blob();
    await saveModel(blob, cacheKey);
    const etag = resp.headers.get('ETag');
    if (etag) await saveMeta(cacheKey, etag);
    return blob;
  } catch (e) {
    // Network / CORS failure → offline-first fallback
    console.warn('[haSync] model fetch failed, using cache:', e);
    return cached;
  }
}
