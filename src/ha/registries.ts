// src/ha/registries.ts
import type { HAConnection } from '../services/haWebSocket';
import type { HAEntityOption } from '../components/EntityPicker';

export interface HAAreaInfo {
  area_id: string;
  name: string;
}

export interface HALabelInfo {
  label_id: string;
  name: string;
  color?: string;
}

export interface HAEntityRegistryEntry {
  entity_id: string;
  device_class: string | null;
  area_id: string | null;
  labels: string[];
}

export interface HARegistries {
  entities: Record<string, HAEntityRegistryEntry>;
  areas: Record<string, HAAreaInfo>;
  labels: Record<string, HALabelInfo>;
}

interface RawEntityRegistryEntry {
  entity_id: string;
  device_class?: string | null;
  original_device_class?: string | null;
  area_id?: string | null;
  labels?: string[];
}
interface RawAreaEntry { area_id: string; name: string }
interface RawLabelEntry { label_id: string; name: string; color?: string }

/**
 * Fetch HA's entity/area/label registries once. Never throws — on any WS
 * error (offline, timeout, unsupported HA version) this logs and resolves
 * `null` so callers can fall back to the unfiltered entity list.
 */
export async function fetchRegistries(conn: HAConnection): Promise<HARegistries | null> {
  try {
    const [entityList, areaList, labelList] = await Promise.all([
      conn.request({ type: 'config/entity_registry/list' }) as Promise<RawEntityRegistryEntry[]>,
      conn.request({ type: 'config/area_registry/list' }) as Promise<RawAreaEntry[]>,
      conn.request({ type: 'config/label_registry/list' }) as Promise<RawLabelEntry[]>,
    ]);

    const entities: Record<string, HAEntityRegistryEntry> = {};
    for (const e of entityList) {
      entities[e.entity_id] = {
        entity_id: e.entity_id,
        device_class: e.device_class ?? e.original_device_class ?? null,
        area_id: e.area_id ?? null,
        labels: e.labels ?? [],
      };
    }

    const areas: Record<string, HAAreaInfo> = {};
    for (const a of areaList) areas[a.area_id] = { area_id: a.area_id, name: a.name };

    const labels: Record<string, HALabelInfo> = {};
    for (const l of labelList) labels[l.label_id] = { label_id: l.label_id, name: l.name, color: l.color };

    return { entities, areas, labels };
  } catch (e) {
    console.error('[registries] fetch failed, falling back to unfiltered entity list:', e);
    return null;
  }
}

/**
 * Attach device_class/area_name/labels to a plain entity list. Registry data
 * wins when present; `stateDeviceClass` (from the live state attribute) is
 * the fallback for entities whose registry entry has no device_class —
 * some integrations only expose it on the state, not the registry.
 */
export function mergeEntityMetadata(
  entities: HAEntityOption[],
  registries: HARegistries | null,
): HAEntityOption[] {
  if (!registries) return entities;
  return entities.map(e => {
    const reg = registries.entities[e.entity_id];
    const areaName = reg?.area_id ? registries.areas[reg.area_id]?.name : undefined;
    const labelNames = (reg?.labels ?? [])
      .map(id => registries.labels[id]?.name)
      .filter((n): n is string => !!n);
    return {
      ...e,
      device_class: reg?.device_class ?? e.device_class,
      area_id: reg?.area_id ?? undefined,
      area_name: areaName,
      labels: labelNames,
    };
  });
}
