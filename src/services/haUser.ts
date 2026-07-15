/**
 * Current-HA-user awareness and per-light access control.
 *
 * The signed-in user (id + admin flag) is fetched over the active WS
 * connection and cached in localStorage so light filtering can happen at
 * boot, before the connection is up. Admins always see every light.
 *
 * Note: this is UI-level visibility inside 3Dash. Anyone with an HA login
 * can still reach the underlying entities through the normal HA frontend.
 */

import { getActiveHAConnection } from './haWebSocket';
import type { LightConfig } from '../types';

export interface HAUserInfo {
  id: string;
  name: string;
  isAdmin: boolean;
}

const USER_CACHE_KEY = '3dash_ha_user';
const USER_LIST_CACHE_KEY = '3dash_ha_users';

export function getCachedUser(): HAUserInfo | null {
  try {
    const raw = localStorage.getItem(USER_CACHE_KEY);
    const u = raw ? JSON.parse(raw) as HAUserInfo : null;
    return u && typeof u.id === 'string' ? u : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the signed-in HA user and update the cache. Returns whether the
 * identity changed vs. the cached one (a change means light visibility may
 * differ and the scene should be rebuilt).
 */
export async function refreshCurrentUser(): Promise<{ user: HAUserInfo; changed: boolean } | null> {
  const ha = getActiveHAConnection();
  if (!ha?.isConnected) return null;
  const res = await ha.request({ type: 'auth/current_user' }) as
    { id?: string; name?: string; is_admin?: boolean } | null;
  if (!res?.id) return null;
  const user: HAUserInfo = { id: res.id, name: res.name ?? '', isAdmin: !!res.is_admin };
  const prev = getCachedUser();
  const changed = !prev || prev.id !== user.id || prev.isAdmin !== user.isAdmin;
  localStorage.setItem(USER_CACHE_KEY, JSON.stringify(user));
  return { user, changed };
}

/** Whether this user may see and control the given light. */
export function canAccessLight(light: LightConfig, user: HAUserInfo | null): boolean {
  const access = light.access;
  if (!access || access.mode === 'everyone') return true;
  if (!user) return false; // restricted light + unknown user → hide until known
  if (user.isAdmin) return true;
  if (access.mode === 'admins') return false;
  return !!access.userIds?.includes(user.id);
}

export function hasRestrictedLights(lights: LightConfig[] | undefined): boolean {
  return !!lights?.some((l) => l.access && l.access.mode !== 'everyone');
}

/* ── HA user directory (for the access picker in the light form) ── */

export interface HAUserEntry {
  id: string;
  name: string;
  isAdmin: boolean;
}

export function getCachedUserList(): HAUserEntry[] {
  try {
    const raw = localStorage.getItem(USER_LIST_CACHE_KEY);
    const list = raw ? JSON.parse(raw) as HAUserEntry[] : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * Fetch all real HA users (admin-only WS command) and cache the list for the
 * config editor, which runs without a persistent connection.
 */
export async function refreshUserList(): Promise<HAUserEntry[]> {
  const ha = getActiveHAConnection();
  if (!ha?.isConnected) return getCachedUserList();
  const res = await ha.request({ type: 'config/auth/list' }) as Array<{
    id: string;
    name: string | null;
    is_active?: boolean;
    system_generated?: boolean;
    group_ids?: string[];
  }>;
  const list: HAUserEntry[] = res
    .filter((u) => !u.system_generated && u.is_active !== false)
    .map((u) => ({
      id: u.id,
      name: u.name ?? u.id,
      isAdmin: !!u.group_ids?.includes('system-admin'),
    }));
  localStorage.setItem(USER_LIST_CACHE_KEY, JSON.stringify(list));
  return list;
}
