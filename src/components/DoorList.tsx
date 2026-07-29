import { useState, useMemo, useEffect } from 'react';
import type { DoorConfig } from '../types';
import type { DetectedOpening } from '../babylon/doorOpenings';
import type { HAEntityOption } from './EntityPicker';
import EntityPicker from './EntityPicker';
import type { HALabelInfo } from '../ha/registries';

/** Synthetic contact sensor for previewing the highlight/swing loop without real hardware. Never sent to HA or saved. */
export const MOCK_CONTACT_ENTITY_ID = 'binary_sensor.mock_contact_demo';

const MOCK_ENTITY: HAEntityOption = {
  entity_id: MOCK_CONTACT_ENTITY_ID,
  friendly_name: 'Demo Contact Sensor (mock)',
  device_class: 'door',
};

const CONTACT_DEVICE_CLASSES = new Set(['door', 'window', 'garage_door']);

function isContactSensor(e: HAEntityOption): boolean {
  return e.entity_id.startsWith('binary_sensor.') && !!e.device_class && CONTACT_DEVICE_CLASSES.has(e.device_class);
}

interface Props {
  detected: DetectedOpening[];
  doors: DoorConfig[];
  haEntities: HAEntityOption[];
  onChange: (doors: DoorConfig[]) => void;
  /** Highlight the opening's meshes in the 3D view. Pass durationMs=0 for "until onClearHighlight". */
  onHighlight: (opening: { meshNames: string[] }, durationMs?: number) => void;
  /** Clear whatever is currently highlighted (used on row mouse-leave). */
  onClearHighlight: () => void;
  /** Swing a door open/closed in the 3D view (editor preview). */
  onTest: (door: DoorConfig, open: boolean) => void;
  /** Play the open-hold-close swing preview once, right after a sensor is bound. */
  onPreviewSwing: (door: DoorConfig) => void;
  labelRegistry?: Record<string, HALabelInfo>;
}

/** Contact-sensor-ish entities first, but allow anything. */
function sortEntities(entities: HAEntityOption[]): HAEntityOption[] {
  const score = (id: string) => (id.startsWith('binary_sensor.') ? 0 : 1);
  return [...entities].sort((a, b) =>
    score(a.entity_id) - score(b.entity_id) || a.entity_id.localeCompare(b.entity_id));
}

/**
 * Editor list for door/window openings detected from the model
 * (SweetHome3D naming convention). Bind each to a contact sensor.
 */
export default function DoorList({ detected, doors, haEntities, onChange, onHighlight, onClearHighlight, onTest, onPreviewSwing, labelRegistry }: Props) {
  const [testOpen, setTestOpen] = useState<Record<string, boolean>>({});
  const [searchText, setSearchText] = useState<Record<string, string>>({});
  const boundIds = new Set(doors.map(d => d.id));
  const unbound = detected.filter(o => !boundIds.has(o.key));
  const entities = useMemo(() => sortEntities([...haEntities, MOCK_ENTITY]), [haEntities]);

  useEffect(() => onClearHighlight, [onClearHighlight]);

  const bind = (opening: DetectedOpening, entityId: string) => {
    if (!entityId) return;
    const door: DoorConfig = {
      id: opening.key,
      entityId,
      label: opening.label,
      kind: opening.kind,
      meshNames: opening.meshNames,
      pivot: opening.pivot,
    };
    onChange([...doors, door]);
    onClearHighlight();
    onPreviewSwing(door);
  };

  const update = (id: string, patch: Partial<DoorConfig>) => {
    onChange(doors.map(d => (d.id === id ? { ...d, ...patch } : d)));
  };

  const remove = (id: string) => {
    const door = doors.find(d => d.id === id);
    if (door) onTest(door, false); // close before unbinding
    onChange(doors.filter(d => d.id !== id));
    onClearHighlight();
  };

  const toggleTest = (door: DoorConfig) => {
    const next = !testOpen[door.id];
    setTestOpen(prev => ({ ...prev, [door.id]: next }));
    onTest(door, next);
  };

  if (!detected.length && !doors.length) {
    return (
      <div className="door-list-empty" style={{ padding: 16, opacity: 0.7, fontSize: 13 }}>
        No doors or windows detected in this model.
        <p style={{ marginTop: 8 }}>
          Detection uses SweetHome3D's export naming
          (<code>sweethome3d_opening_on_hinge_…</code>). Export your model from
          SweetHome3D as OBJ/GLB with furniture doors/windows and they will
          appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="door-list">
      {doors.map(door => (
        <div
          key={door.id}
          className="door-list-item"
          style={{ padding: '8px 10px', borderBottom: '1px solid rgba(128,128,128,0.2)' }}
          onMouseEnter={() => onHighlight(door, 0)}
          onMouseLeave={onClearHighlight}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>{door.kind === 'window' ? '🪟' : '🚪'}</span>
            <strong style={{ flex: 1 }}>{door.label ?? door.id}</strong>
            <button className="btn btn-ghost" title="Highlight in 3D view" onClick={() => onHighlight(door)}>⌖</button>
            <button className="btn btn-ghost" title="Test swing" onClick={() => toggleTest(door)}>
              {testOpen[door.id] ? 'Close' : 'Open'}
            </button>
            <button className="btn btn-ghost" title="Unbind" onClick={() => remove(door.id)}>×</button>
          </div>
          <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>{door.entityId}</div>
          <div style={{ display: 'flex', gap: 10, marginTop: 6, fontSize: 12, alignItems: 'center' }}>
            <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={!!door.invert}
                onChange={e => { update(door.id, { invert: e.target.checked }); onTest({ ...door, invert: e.target.checked }, !!testOpen[door.id]); }}
              />
              invert swing
            </label>
            <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              angle
              <input
                type="number"
                min={10}
                max={170}
                value={door.openAngle ?? 80}
                style={{ width: 52 }}
                onChange={e => update(door.id, { openAngle: parseInt(e.target.value, 10) || 80 })}
              />
              °
            </label>
          </div>
        </div>
      ))}

      {unbound.length > 0 && (
        <div style={{ padding: '10px 10px 4px', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, opacity: 0.6 }}>
          Detected in model
        </div>
      )}
      {unbound.map(o => (
        <div
          key={o.key}
          className="door-list-item"
          style={{ padding: '8px 10px', borderBottom: '1px solid rgba(128,128,128,0.2)' }}
          onMouseEnter={() => onHighlight(o, 0)}
          onMouseLeave={onClearHighlight}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>{o.kind === 'window' ? '🪟' : '🚪'}</span>
            <strong style={{ flex: 1 }}>{o.label}</strong>
            <button className="btn btn-ghost" title="Highlight in 3D view" onClick={() => onHighlight(o)}>⌖</button>
          </div>
          <EntityPicker
            value={searchText[o.key] ?? ''}
            onChange={v => setSearchText(prev => ({ ...prev, [o.key]: v }))}
            onSelect={en => { bind(o, en.entity_id); setSearchText(prev => { const next = { ...prev }; delete next[o.key]; return next; }); }}
            placeholder="Bind contact sensor…"
            entities={entities}
            filterPredicate={isContactSensor}
            filterToggleLabel="Show all entities"
            groupByArea
            labelRegistry={labelRegistry}
            className="door-bind-input"
          />
        </div>
      ))}
    </div>
  );
}
