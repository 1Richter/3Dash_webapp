# Door/Window Editor Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the Doors tab of `ConfigEditor` with a glowing 3D highlight + swing preview on hover/bind, and a smart contact-sensor picker filtered by device_class, grouped by area, filterable by HA labels, with a mock sensor for hardware-free testing.

**Architecture:** Extend four existing files in place (`doorOpenings.ts`, `EntityPicker.tsx`, `DoorList.tsx`, `ConfigEditor.tsx`) plus one new module (`src/ha/registries.ts`). No new npm dependencies — Babylon's `HighlightLayer` ships in `@babylonjs/core`, already a project dependency.

**Tech Stack:** React 18 + TypeScript, Babylon.js 7 (`@babylonjs/core`), Vite. No test framework is installed in this project (no vitest/jest, no existing `*.test.ts` files) — do not add one as part of this plan. Verification is manual: `npm run build` (tsc typecheck + vite build) after every task, plus a `npm run dev` + browser check for anything visual. Playwright MCP tools (`mcp__plugin_playwright_playwright__*`) are available for the visual checks — use `browser_navigate` to the local dev URL, `browser_snapshot`/`browser_take_screenshot` to inspect, `browser_hover`/`browser_click` to exercise interactions.

## Global Constraints

- Stack is Babylon.js, not Three.js/R3F (corrected during brainstorming from the original request wording).
- No changes to `DoorConfig` persistence shape (spec, "Out of scope").
- No changes to dashboard-side (non-editor) door rendering (spec, "Out of scope").
- Mock sensor is purely client-side UI sugar — never sent to HA, never saved to config (spec Decision A: strip/block save while a mock binding is active).
- Label chip filtering is OR (union) across selected chips, not AND (spec decision).
- `device_class` merge must fall back to the live state attribute (`HAState.attributes.device_class`) when the entity registry entry lacks one — `subscribe_entities`/`get_states` payloads carry attributes but registry entries can have a null `device_class` for some integrations (spec feedback).
- `previewSwing` must cancel/clear any in-flight preview for the same door before starting a new one (no overlapping animations) (spec feedback).
- `highlightOpening`/`clearHighlight` must always fully clear the previous highlight before adding a new one, so fast mouse movement across 20+ rows never leaves orphaned glowing meshes (spec feedback).
- Memoize merged entity lists and row-level callbacks (`useMemo`/`useCallback`) so a change to one door's config doesn't force all bound rows' `EntityPicker`s to recompute their filtered/grouped view (spec feedback).

---

### Task 1: Glow highlight in `doorOpenings.ts`

**Files:**
- Modify: `src/babylon/doorOpenings.ts`

**Interfaces:**
- Produces: `highlightOpening(scene: Scene, meshNames: string[], durationMs?: number): void` (default `durationMs = 1800`; pass `0` for "stays until explicitly cleared", used by hover).
- Produces: `clearHighlight(scene: Scene): void`

- [ ] **Step 1: Add imports and module-level highlight state**

At the top of `src/babylon/doorOpenings.ts`, change the import line:

```ts
import { Scene, AbstractMesh, TransformNode, Animation, QuadraticEase, EasingFunction, Vector3, HighlightLayer, Color3, Mesh } from '@babylonjs/core';
```

Add near the other module-level state (after the `pivotNodes` map, before `resetDoorPivots`):

```ts
/* ── Highlight ── */

let highlightLayer: HighlightLayer | null = null;
let highlightedMeshNames: string[] = [];
let highlightTimer: ReturnType<typeof setTimeout> | null = null;

function getHighlightLayer(scene: Scene): HighlightLayer {
  if (!highlightLayer || highlightLayer.getScene() !== scene) {
    highlightLayer = new HighlightLayer('door-highlight-layer', scene);
  }
  return highlightLayer;
}

/** Remove any active highlight. Always safe to call, even if nothing is highlighted. */
export function clearHighlight(scene: Scene): void {
  if (highlightTimer) {
    clearTimeout(highlightTimer);
    highlightTimer = null;
  }
  if (!highlightedMeshNames.length) return;
  const layer = getHighlightLayer(scene);
  for (const name of highlightedMeshNames) {
    const m = scene.getMeshByName(name);
    if (m) layer.removeMesh(m as Mesh);
  }
  highlightedMeshNames = [];
}

/**
 * Glow the given meshes green. Always clears any previous highlight first, so
 * rapidly hovering across many rows never leaves orphaned glowing meshes.
 * `durationMs = 0` means "leave highlighted until clearHighlight() is called"
 * (used for hover); a positive value auto-clears after that many ms (used for
 * the explicit bind/test actions).
 */
export function highlightOpening(scene: Scene, meshNames: string[], durationMs = 1800): void {
  clearHighlight(scene);
  const layer = getHighlightLayer(scene);
  const meshes = meshNames
    .map(n => scene.getMeshByName(n))
    .filter((m): m is AbstractMesh => !!m);
  for (const m of meshes) layer.addMesh(m as Mesh, Color3.Green());
  highlightedMeshNames = meshNames;
  if (durationMs > 0) {
    highlightTimer = setTimeout(() => clearHighlight(scene), durationMs);
  }
}
```

- [ ] **Step 2: Update `resetDoorPivots` to also reset highlight state**

Find the existing function:

```ts
export function resetDoorPivots(): void {
  pivotNodes.clear();
}
```

Replace with:

```ts
export function resetDoorPivots(): void {
  pivotNodes.clear();
  highlightLayer = null;
  highlightedMeshNames = [];
  if (highlightTimer) {
    clearTimeout(highlightTimer);
    highlightTimer = null;
  }
}
```

(This runs on scene dispose/rebuild — without it, a stale `HighlightLayer` reference from a disposed scene would throw on the next highlight call.)

- [ ] **Step 3: Manual verification**

Run `npm run build` — must complete with no TypeScript errors (this catches Babylon type mismatches like `AbstractMesh` vs `Mesh` immediately).

- [ ] **Step 4: Commit**

```bash
git add src/babylon/doorOpenings.ts
git commit -m "feat: replace door highlight bounding-box flash with HighlightLayer glow"
```

---

### Task 2: Swing preview with overlap guard in `doorOpenings.ts`

**Files:**
- Modify: `src/babylon/doorOpenings.ts`

**Interfaces:**
- Consumes: `applyDoorState(scene, door, open, animate?)` (existing, unchanged), `pivotFor(scene, door)` (existing private helper, already in this file).
- Produces: `previewSwing(scene: Scene, door: DoorConfig): void`

- [ ] **Step 1: Extract the animation duration as a named constant**

Find the existing `applyDoorState` body:

```ts
  const fps = 30;
  const anim = new Animation(`door-${door.id}`, 'rotation.y', fps,
    Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CONSTANT);
  anim.setKeys([
    { frame: 0, value: node.rotation.y },
    { frame: fps * 0.7, value: target },
  ]);
```

Replace the `fps` local with a module-level constant so `previewSwing` can derive the real duration instead of guessing a number that might drift out of sync:

At the top of the file, near `const OPENING_RE` / `const HINGE_RE`, add:

```ts
const SWING_FPS = 30;
const SWING_FRAMES = SWING_FPS * 0.7;
/** Wall-clock duration of the open/close tween in applyDoorState, in ms. */
const SWING_DURATION_MS = (SWING_FRAMES / SWING_FPS) * 1000;
```

Then update `applyDoorState` to use them instead of the local `fps`/`fps * 0.7`:

```ts
  const anim = new Animation(`door-${door.id}`, 'rotation.y', SWING_FPS,
    Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CONSTANT);
  anim.setKeys([
    { frame: 0, value: node.rotation.y },
    { frame: SWING_FRAMES, value: target },
  ]);
  const ease = new QuadraticEase();
  ease.setEasingMode(EasingFunction.EASINGMODE_EASEINOUT);
  anim.setEasingFunction(ease);
  scene.beginDirectAnimation(node, [anim], 0, SWING_FRAMES, false);
```

- [ ] **Step 2: Add `previewSwing` with a per-door overlap guard**

Add after `applyDoorState`:

```ts
/* ── Swing preview ── */

const activePreviews = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Open the door, hold briefly, then close it again — used to preview a
 * binding without needing the real contact sensor to change state.
 * Cancels any preview already in progress for this door before starting,
 * so rapid re-triggering (e.g. mashing the bind dropdown) never stacks
 * overlapping open/close animations.
 */
export function previewSwing(scene: Scene, door: DoorConfig): void {
  const existing = activePreviews.get(door.id);
  if (existing) {
    clearTimeout(existing);
    activePreviews.delete(door.id);
  }
  const node = pivotFor(scene, door);
  if (node) scene.stopAnimation(node);

  applyDoorState(scene, door, true);
  const HOLD_MS = SWING_DURATION_MS + 200; // pause after the open tween finishes
  const timer = setTimeout(() => {
    applyDoorState(scene, door, false);
    activePreviews.delete(door.id);
  }, HOLD_MS);
  activePreviews.set(door.id, timer);
}
```

- [ ] **Step 3: Manual verification**

Run `npm run build` — no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/babylon/doorOpenings.ts
git commit -m "feat: add previewSwing with per-door overlap guard"
```

---

### Task 3: HA registry fetch module

**Files:**
- Create: `src/ha/registries.ts`

**Interfaces:**
- Consumes: `HAConnection.request(msg: Record<string, unknown>): Promise<unknown>` (existing, `src/services/haWebSocket.ts:221`).
- Consumes: `HAEntityOption` (existing, `src/components/EntityPicker.tsx`) — extended in Task 4 with the fields this module fills in.
- Produces: `HAAreaInfo`, `HALabelInfo`, `HAEntityRegistryEntry`, `HARegistries` types.
- Produces: `fetchRegistries(conn: HAConnection): Promise<HARegistries | null>` — resolves `null` (never throws) on any WS error, per spec's "swallow and log" error handling.
- Produces: `mergeEntityMetadata(entities: HAEntityOption[], registries: HARegistries | null): HAEntityOption[]` — pure function, used by ConfigEditor to attach `device_class`/`area_name`/`labels` to the plain entity list.

- [ ] **Step 1: Write the module**

```ts
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
```

- [ ] **Step 2: Manual verification**

Run `npm run build` — no TypeScript errors (this will initially fail on `HAEntityOption` not yet having `device_class`/`area_id`/`area_name`/`labels` — that's expected and fixed in Task 4; if this task is executed strictly before Task 4, confirm the *only* errors are about those missing fields on `HAEntityOption`, nothing else).

- [ ] **Step 3: Commit**

```bash
git add src/ha/registries.ts
git commit -m "feat: add HA entity/area/label registry fetch + metadata merge"
```

---

### Task 4: Extend `HAEntityOption` and add filtering/grouping/labels to `EntityPicker`

**Files:**
- Modify: `src/components/EntityPicker.tsx`
- Modify: `src/components/EntityPicker.css`

**Interfaces:**
- Consumes: `HALabelInfo` from `src/ha/registries.ts` (Task 3).
- Produces: extended `HAEntityOption` (`device_class?: string`, `area_id?: string`, `area_name?: string`, `labels?: string[]`) — every existing consumer (`ConfigEditor.tsx`, `Dashboard.tsx`, `CardPropertiesPanel.tsx`, `LightForm.tsx`, `TubeForm.tsx`, `DisplayForm.tsx`) keeps working unchanged since the new fields are optional.
- Produces: new optional `EntityPicker` props — `filterPredicate?: (e: HAEntityOption) => boolean`, `filterToggleLabel?: string`, `groupByArea?: boolean`, `labelRegistry?: Record<string, HALabelInfo>`.

- [ ] **Step 1: Extend the type and props**

Change:

```ts
export interface HAEntityOption {
  entity_id: string;
  friendly_name?: string;
}
```

to:

```ts
export interface HAEntityOption {
  entity_id: string;
  friendly_name?: string;
  device_class?: string;
  area_id?: string;
  area_name?: string;
  labels?: string[];
}
```

Change the `Props` interface — add after `className?: string;`:

```ts
  /**
   * When set, entities failing this predicate are hidden by default. A
   * "show all" checkbox (labelled `filterToggleLabel`) lets the user disable
   * it. Omit for the old unfiltered behavior (used by every non-door caller).
   */
  filterPredicate?: (e: HAEntityOption) => boolean;
  filterToggleLabel?: string;
  /** Group dropdown results by `area_name` (entities with none go under "Other"). */
  groupByArea?: boolean;
  /** label_id -> info, used to render clickable filter chips above the search input. */
  labelRegistry?: Record<string, { label_id: string; name: string; color?: string }>;
```

- [ ] **Step 2: Add filter-toggle, label-chip, and grouping state**

Add new state near the existing `useState` calls:

```ts
  const [showAll, setShowAll] = useState(false);
  const [activeLabels, setActiveLabels] = useState<Set<string>>(new Set());
```

Add a memoized list of label ids actually present on candidate entities (only show chips that are useful), computed from the raw `entities` prop before predicate filtering — insert right after the `filtered` memo's dependencies are declared (near the top of the component body, after existing `useRef`/`useState` declarations, before the `filtered` memo):

```ts
  const availableLabelIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of entities) for (const id of e.labels ?? []) ids.add(id);
    return [...ids];
  }, [entities]);
```

- [ ] **Step 3: Rewrite the `filtered` memo to apply predicate, label chips, and search together**

Replace the existing:

```ts
  const filtered = useMemo(() => {
    if (entities.length === 0) return [];
    const q = value.toLowerCase();
    if (!q) return entities.slice(0, MAX_RESULTS);
    return entities
      .filter(e =>
        e.entity_id.toLowerCase().includes(q) ||
        (e.friendly_name?.toLowerCase().includes(q) ?? false),
      )
      .slice(0, MAX_RESULTS);
  }, [entities, value]);
```

with:

```ts
  const filtered = useMemo(() => {
    if (entities.length === 0) return [];
    let pool = entities;
    if (filterPredicate && !showAll) pool = pool.filter(filterPredicate);
    if (activeLabels.size > 0) {
      // OR across selected chips: an entity matches if it carries ANY active label.
      pool = pool.filter(e => (e.labels ?? []).some(id => activeLabels.has(id)));
    }
    const q = value.toLowerCase();
    if (q) {
      pool = pool.filter(e =>
        e.entity_id.toLowerCase().includes(q) ||
        (e.friendly_name?.toLowerCase().includes(q) ?? false),
      );
    }
    return pool.slice(0, MAX_RESULTS);
  }, [entities, value, filterPredicate, showAll, activeLabels]);
```

- [ ] **Step 4: Group results by area when `groupByArea` is set**

Add a new memo right after `filtered`:

```ts
  const grouped = useMemo(() => {
    if (!groupByArea) return null;
    const groups = new Map<string, HAEntityOption[]>();
    for (const e of filtered) {
      const key = e.area_name ?? 'Other';
      const list = groups.get(key) ?? [];
      list.push(e);
      groups.set(key, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b));
  }, [filtered, groupByArea]);
```

- [ ] **Step 5: Render the "show all" toggle and label chips above the input, and use `grouped` in the dropdown**

The toggle/chips only make sense while the dropdown is open and only when the relevant props are passed, so render them inside the same portal block, above the results list. Change the dropdown's `createPortal` content — find:

```tsx
      {open && filtered.length > 0 && dropdownStyle && createPortal(
        <div
          ref={dropdownRef}
          className="entity-picker-dropdown"
          style={dropdownStyle}
          id={listboxId}
          role="listbox"
        >
          {filtered.map((e, i) => (
```

Replace the whole block (through its closing `</div>,\n        document.body,\n      )}`) with:

```tsx
      {open && dropdownStyle && createPortal(
        <div
          ref={dropdownRef}
          className="entity-picker-dropdown"
          style={dropdownStyle}
        >
          {(filterPredicate || (labelRegistry && availableLabelIds.length > 0)) && (
            <div className="entity-picker-controls">
              {filterPredicate && (
                <label className="entity-picker-showall">
                  <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} />
                  {filterToggleLabel ?? 'Show all entities'}
                </label>
              )}
              {labelRegistry && availableLabelIds.length > 0 && (
                <div className="entity-picker-chips">
                  {availableLabelIds.map(id => {
                    const info = labelRegistry[id];
                    if (!info) return null;
                    const active = activeLabels.has(id);
                    return (
                      <button
                        key={id}
                        type="button"
                        className={`entity-picker-chip${active ? ' active' : ''}`}
                        style={info.color ? { borderColor: info.color } : undefined}
                        onMouseDown={ev => ev.preventDefault()}
                        onClick={() => setActiveLabels(prev => {
                          const next = new Set(prev);
                          active ? next.delete(id) : next.add(id);
                          return next;
                        })}
                      >
                        {info.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {filtered.length === 0 ? (
            <div className="entity-picker-empty">No matching entities.</div>
          ) : (
            <div id={listboxId} role="listbox">
              {(grouped ?? [['', filtered]] as [string, HAEntityOption[]][]).map(([groupName, groupEntities]) => (
                <div key={groupName || '_flat'}>
                  {grouped && <div className="entity-picker-group-header">{groupName}</div>}
                  {groupEntities.map((e) => {
                    const i = filtered.indexOf(e);
                    return (
                      <div
                        key={e.entity_id}
                        id={`${listboxId}-${i}`}
                        ref={el => { itemRefs.current[i] = el; }}
                        className={`entity-picker-item${i === highlighted ? ' highlighted' : ''}`}
                        role="option"
                        aria-selected={i === highlighted}
                        onMouseDown={ev => { ev.preventDefault(); select(e); }}
                        onMouseEnter={() => setHighlighted(i)}
                      >
                        <span className="entity-picker-id">{e.entity_id}</span>
                        {e.friendly_name && e.friendly_name !== e.entity_id && (
                          <span className="entity-picker-name">{e.friendly_name}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>,
        document.body,
      )}
```

Note the render condition changed from `open && filtered.length > 0` to `open && dropdownStyle` — the empty-state message and the "show all" escape hatch both need to render even when `filtered` is empty (that's the whole point of the escape hatch).

- [ ] **Step 6: CSS for the new controls**

Append to `src/components/EntityPicker.css`:

```css
.entity-picker-controls {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.entity-picker-showall {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--muted);
  cursor: pointer;
}

.entity-picker-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.entity-picker-chip {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border2);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.entity-picker-chip.active {
  background: var(--accent);
  color: var(--bg);
  border-color: var(--accent);
}

.entity-picker-group-header {
  padding: 6px 10px 2px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--muted);
  opacity: 0.7;
}

.entity-picker-empty {
  padding: 10px;
  font-size: 12px;
  color: var(--muted);
}
```

- [ ] **Step 7: Manual verification**

Run `npm run build` — no TypeScript errors. Then run `npm run dev`, open the app, and check a non-door entity picker (e.g. a Light's entity field in the Lights tab) still opens, searches, and selects exactly as before — the new props are all optional so this must be a no-op for existing callers. Use the Playwright MCP tools (`browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot`) to confirm the dropdown opens and typing filters the list on the Lights tab.

- [ ] **Step 8: Commit**

```bash
git add src/components/EntityPicker.tsx src/components/EntityPicker.css
git commit -m "feat: add filter/group/label-chip support to EntityPicker"
```

---

### Task 5: Wire `DoorList.tsx` to the new picker, hover highlight, and mock sensor

**Files:**
- Modify: `src/components/DoorList.tsx`

**Interfaces:**
- Consumes: `EntityPicker` (Task 4, with `filterPredicate`/`groupByArea`/`labelRegistry`/`filterToggleLabel` props), `HAEntityOption` (Task 4).
- Consumes: `highlightOpening(scene, meshNames, durationMs?)`, `clearHighlight(scene)` (Task 1) — via new `onClearHighlight` prop wired in Task 6, since `DoorList` itself has no scene reference.
- Produces: exported `MOCK_CONTACT_ENTITY_ID = 'binary_sensor.mock_contact_demo'` constant — consumed by `ConfigEditor.tsx` (Task 6) to gate the save button.
- Produces: new `Props.onClearHighlight: () => void` and `Props.labelRegistry?: Record<string, HALabelInfo>`.

- [ ] **Step 1: Add the mock entity constant and predicate helpers**

At the top of `src/components/DoorList.tsx`, after the existing imports, add:

```ts
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
```

- [ ] **Step 2: Update `Props` and the component signature**

Replace:

```ts
interface Props {
  detected: DetectedOpening[];
  doors: DoorConfig[];
  haEntities: HAEntityOption[];
  onChange: (doors: DoorConfig[]) => void;
  /** Briefly highlight the opening's meshes in the 3D view. */
  onHighlight: (opening: { meshNames: string[] }) => void;
  /** Swing a door open/closed in the 3D view (editor preview). */
  onTest: (door: DoorConfig, open: boolean) => void;
}
```

with:

```ts
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
  labelRegistry?: Record<string, HALabelInfo>;
}
```

Update the function signature line:

```ts
export default function DoorList({ detected, doors, haEntities, onChange, onHighlight, onClearHighlight, onTest, labelRegistry }: Props) {
```

- [ ] **Step 3: Inject the mock entity and memoize the picker's entity list**

Right after the existing `const entities = sortEntities(haEntities);` line, replace it with:

```ts
  const entities = useMemo(() => sortEntities([...haEntities, MOCK_ENTITY]), [haEntities]);
```

Add `useMemo` to the React import at the top of the file:

```ts
import { useState, useMemo } from 'react';
```

- [ ] **Step 4: Wire hover highlight on both bound and unbound rows**

For the bound-doors row (the `doors.map(door => ...)` block), add hover handlers to the outer `<div className="door-list-item" ...>`:

```tsx
        <div
          key={door.id}
          className="door-list-item"
          style={{ padding: '8px 10px', borderBottom: '1px solid rgba(128,128,128,0.2)' }}
          onMouseEnter={() => onHighlight(door, 0)}
          onMouseLeave={onClearHighlight}
        >
```

For the unbound-openings row (the `unbound.map(o => ...)` block), same treatment:

```tsx
        <div
          key={o.key}
          className="door-list-item"
          style={{ padding: '8px 10px', borderBottom: '1px solid rgba(128,128,128,0.2)' }}
          onMouseEnter={() => onHighlight(o, 0)}
          onMouseLeave={onClearHighlight}
        >
```

The existing `⌖` "Highlight in 3D view" buttons keep calling `onHighlight(door)` / `onHighlight(o)` with no second argument — `ConfigEditor`'s handler (Task 6) treats a missing/undefined `durationMs` as the auto-clearing default, so the explicit button still auto-clears after ~1.8s while hover stays lit until the mouse leaves.

- [ ] **Step 5: Swap the plain `<select>` for `EntityPicker`**

Replace:

```tsx
          <select
            style={{ width: '100%', marginTop: 6 }}
            defaultValue=""
            onChange={e => bind(o, e.target.value)}
          >
            <option value="" disabled>Bind contact sensor…</option>
            {entities.map(en => (
              <option key={en.entity_id} value={en.entity_id}>
                {en.friendly_name ? `${en.friendly_name} (${en.entity_id})` : en.entity_id}
              </option>
            ))}
          </select>
```

with:

```tsx
          <EntityPicker
            value=""
            onChange={() => { /* free typing not persisted; selection handled in onSelect */ }}
            onSelect={en => bind(o, en.entity_id)}
            placeholder="Bind contact sensor…"
            entities={entities}
            filterPredicate={isContactSensor}
            filterToggleLabel="Show all entities"
            groupByArea
            labelRegistry={labelRegistry}
            className="door-bind-input"
          />
```

Add the import near the top of the file:

```ts
import EntityPicker from './EntityPicker';
```

- [ ] **Step 6: CSS for the new input (reuse existing input look)**

`EntityPicker`'s `className` prop is applied directly to its `<input>`. Check `src/components/DoorList.tsx`'s current stylesheet usage — there's no dedicated CSS file for `DoorList`, styles are inline. Add a minimal inline-consistent class in `ConfigEditor.css` (the shared stylesheet already loaded by this page) so the bind input matches other inputs in the sidebar:

- [ ] **Step 6a:** Check whether `ConfigEditor.css` already styles plain inputs generically (e.g. an `input[type=text]` or `.sidebar input` rule). Search: `grep -n "input" src/pages/ConfigEditor/ConfigEditor.css`. If a generic rule already covers bare `<input>` elements, skip 6b. If nothing matches, add 6b.

- [ ] **Step 6b (only if needed):** Append to `src/pages/ConfigEditor/ConfigEditor.css`:

```css
.door-bind-input {
  width: 100%;
  margin-top: 6px;
  box-sizing: border-box;
}
```

- [ ] **Step 7: Manual verification**

Run `npm run build` — no TypeScript errors. Then `npm run dev`, open the Doors tab, and manually confirm: hovering an unbound row shows the glow (requires Task 6 wiring to actually reach the scene — if Task 6 isn't done yet, confirm at least that `onHighlight`/`onClearHighlight` are being called by temporarily adding a `console.log`, then remove it before committing); the bind input opens a searchable dropdown; the mock sensor appears in results; selecting it creates a bound row with a working Open/Close toggle.

- [ ] **Step 8: Commit**

```bash
git add src/components/DoorList.tsx
git commit -m "feat: DoorList uses EntityPicker with contact-sensor filter, hover highlight, mock sensor"
```

---

### Task 6: Wire it all up in `ConfigEditor.tsx`

**Files:**
- Modify: `src/pages/ConfigEditor/ConfigEditor.tsx`

**Interfaces:**
- Consumes: `fetchRegistries`, `mergeEntityMetadata`, `HARegistries` (Task 3); `highlightOpening`, `clearHighlight`, `previewSwing` (Tasks 1-2); `MOCK_CONTACT_ENTITY_ID` (Task 5); extended `DoorList` props (Task 5).

- [ ] **Step 1: Add registry state and lazy fetch on entering the Doors tab**

Near the existing `const [haEntities, setHaEntities] = useState<HAEntityOption[]>(() => getEntityCache());` (line ~82), add:

```ts
  const [registries, setRegistries] = useState<HARegistries | null>(null);
```

Add the import near the top:

```ts
import { fetchRegistries, mergeEntityMetadata, type HARegistries } from '../../ha/registries';
```

Find the existing "Detect model openings whenever the doors tab is opened" effect (around line 1764):

```ts
  useEffect(() => {
    if (editorMode !== 'doors') return;
    const scene = sceneCtxRef.current?.scene;
    if (scene) setDetectedOpenings(detectOpenings(scene));
  }, [editorMode]);
```

Add a sibling effect right after it:

```ts
  // Lazily fetch HA entity/area/label registries the first time the Doors
  // tab is opened — not needed for any other tab, and registries can be
  // large, so this must not run on every ConfigEditor mount.
  useEffect(() => {
    if (editorMode !== 'doors' || registries) return;
    const { mode, haSettings } = getSetting('connection');
    const embedded = hasEmbeddedAuth() || (isEmbedded() && !haSettings.token && !hasOAuth());
    if (mode !== 'live' || !haSettings.url || (!haSettings.token && !hasOAuth() && !embedded)) return;
    const conn = new HAConnection(
      embedded
        ? { url: haSettings.url, port: haSettings.port, tokenProvider: getEmbeddedAccessToken }
        : hasOAuth()
          ? { url: haSettings.url, port: haSettings.port, tokenProvider: getOAuthAccessToken }
          : { url: haSettings.url, port: haSettings.port, token: haSettings.token },
      {
        onStatusChanged: (status) => {
          if (status !== 'connected') return;
          fetchRegistries(conn).then(r => {
            setRegistries(r);
            conn.dispose();
          });
        },
      },
    );
    conn.connect();
    return () => conn.dispose();
  }, [editorMode, registries]);
```

- [ ] **Step 2: Also capture `device_class` from live states so the merge fallback has something to fall back to**

Find the existing entity-list effect (around line 97-121), specifically:

```ts
        onInitialStates: (states: HAState[]) => {
          const entities: HAEntityOption[] = states
            .map(s => ({ entity_id: s.entity_id, friendly_name: s.attributes.friendly_name as string | undefined }))
            .sort((a, b) => a.entity_id.localeCompare(b.entity_id));
```

Change the `.map` to also capture `device_class`:

```ts
        onInitialStates: (states: HAState[]) => {
          const entities: HAEntityOption[] = states
            .map(s => ({
              entity_id: s.entity_id,
              friendly_name: s.attributes.friendly_name as string | undefined,
              device_class: s.attributes.device_class as string | undefined,
            }))
            .sort((a, b) => a.entity_id.localeCompare(b.entity_id));
```

- [ ] **Step 3: Build the merged, memoized entity list for the door picker**

Add near where `doors`/`detectedOpenings` state lives (or right before the `DoorList` usage, whichever reads more naturally in the file — place it directly above the `handleHighlightOpening` callback declared around line 1770):

```ts
  const doorPickerEntities = useMemo(
    () => mergeEntityMetadata(haEntities, registries),
    [haEntities, registries],
  );
```

Confirm `useMemo` is already imported from React at the top of the file (`ConfigEditor.tsx` is large and almost certainly already imports it — check with `grep -n "^import.*useMemo" src/pages/ConfigEditor/ConfigEditor.tsx`; add it to the existing React import if missing).

- [ ] **Step 4: Update the highlight/clear/test handlers**

`onTest` also drives the persistent Open/Close toggle on bound rows (`toggleTest` in `DoorList.tsx`), which must stay a simple, non-reverting toggle (spec: "must survive independent of hover"). So `previewSwing` must NOT be called from `handleTestDoor` — it would auto-close the door ~900ms later and break that toggle. `previewSwing` is wired separately, only on bind (Step 5).

Replace:

```ts
  const handleHighlightOpening = useCallback((opening: { meshNames: string[] }) => {
    const scene = sceneCtxRef.current?.scene;
    if (!scene) return;
    const meshes = opening.meshNames
      .map(n => scene.getMeshByName(n))
      .filter((m): m is NonNullable<ReturnType<typeof scene.getMeshByName>> => !!m);
    for (const m of meshes) m.showBoundingBox = true;
    setTimeout(() => { for (const m of meshes) m.showBoundingBox = false; }, 1800);
  }, []);

  const handleTestDoor = useCallback((door: DoorConfig, open: boolean) => {
    const scene = sceneCtxRef.current?.scene;
    if (scene) applyDoorState(scene, door, open);
  }, []);
```

with:

```ts
  const handleHighlightOpening = useCallback((opening: { meshNames: string[] }, durationMs?: number) => {
    const scene = sceneCtxRef.current?.scene;
    if (scene) highlightOpening(scene, opening.meshNames, durationMs);
  }, []);

  const handleClearHighlight = useCallback(() => {
    const scene = sceneCtxRef.current?.scene;
    if (scene) clearHighlight(scene);
  }, []);

  const handleTestDoor = useCallback((door: DoorConfig, open: boolean) => {
    const scene = sceneCtxRef.current?.scene;
    if (scene) applyDoorState(scene, door, open);
  }, []);
```

(`handleTestDoor` is otherwise unchanged from today — only `handleHighlightOpening`/`handleClearHighlight` now call the imported `highlightOpening`/`clearHighlight` instead of the inline bounding-box code.)

- [ ] **Step 5: Trigger `previewSwing` on bind, not on hover or manual toggle**

Back in `src/components/DoorList.tsx` (Task 5's `bind` function), this plan deferred the swing trigger — fix it now. Find:

```ts
  const bind = (opening: DetectedOpening, entityId: string) => {
    if (!entityId) return;
    onChange([...doors, {
      id: opening.key,
      entityId,
      label: opening.label,
      kind: opening.kind,
      meshNames: opening.meshNames,
      pivot: opening.pivot,
    }]);
  };
```

Add a new prop `onPreviewSwing: (door: DoorConfig) => void` to `DoorList`'s `Props` (alongside `onClearHighlight`), and call it after binding:

```ts
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
    onPreviewSwing(door);
  };
```

Update the function signature to destructure `onPreviewSwing` too, and pass it through from `ConfigEditor.tsx`:

```ts
  const handlePreviewSwing = useCallback((door: DoorConfig) => {
    const scene = sceneCtxRef.current?.scene;
    if (scene) previewSwing(scene, door);
  }, []);
```

- [ ] **Step 6: Update the `DoorList` JSX usage**

Replace:

```tsx
            <DoorList
              detected={detectedOpenings}
              doors={doors}
              haEntities={haEntities}
              onChange={setDoors}
              onHighlight={handleHighlightOpening}
              onTest={handleTestDoor}
            />
```

with:

```tsx
            <DoorList
              detected={detectedOpenings}
              doors={doors}
              haEntities={doorPickerEntities}
              onChange={setDoors}
              onHighlight={handleHighlightOpening}
              onClearHighlight={handleClearHighlight}
              onPreviewSwing={handlePreviewSwing}
              onTest={handleTestDoor}
              labelRegistry={registries?.labels}
            />
```

- [ ] **Step 7: Gate the Save button on the mock sensor being bound**

Add near `handleSaveConfig` (around line 1754):

```ts
  const hasMockBinding = useMemo(
    () => doors.some(d => d.entityId === MOCK_CONTACT_ENTITY_ID),
    [doors],
  );
```

Import the constant:

```ts
import { MOCK_CONTACT_ENTITY_ID } from '../../components/DoorList';
```

Update `handleSaveConfig` to refuse saving while a mock binding is active (matches spec Decision A — block, don't silently strip, so the user isn't surprised by a config that lost a door binding):

```ts
  const handleSaveConfig = useCallback(async () => {
    if (hasMockBinding) {
      alert('Unbind the demo/mock contact sensor before saving — it only exists for local preview and cannot be sent to Home Assistant.');
      return;
    }
    try {
      await updateConfig({ lights, lightGroups, displays, shadowWalls, tubes, doors });
      showToast(`Saved ${lights.length} lights + ${displays.length} displays + ${shadowWalls.length} walls + ${tubes.length} tubes + ${doors.length} doors to server`);
    } catch (e) {
      alert('Failed to save config: ' + (e instanceof Error ? e.message : e));
    }
  }, [lights, displays, shadowWalls, tubes, doors, showToast, hasMockBinding]);
```

Update the Save button to visibly reflect the blocked state:

```tsx
          <button
            className="btn btn-success"
            onClick={handleSaveConfig}
            disabled={hasMockBinding}
            title={hasMockBinding ? 'Unbind the demo/mock contact sensor first' : undefined}
          >
            &darr; Save to server
          </button>
```

- [ ] **Step 8: Manual verification (full flow)**

1. Run `npm run build` — no TypeScript errors.
2. Run `npm run dev`, connect to a live HA instance (or the demo/offline mode already supported by this app).
3. Open the Doors tab.
4. Hover an unbound row → confirm the model glows green in the 3D view and clears on mouse-leave (use Playwright `browser_hover` + `browser_take_screenshot` if testing headlessly, or check manually in the browser).
5. Click "Bind contact sensor…", search for `mock`, select the demo entity → confirm the door swings open, holds, and swings closed automatically, and a new bound row appears with a working manual Open/Close toggle.
6. Confirm the Save button is now disabled with the mock warning; unbind it (× button) and confirm Save re-enables.
7. If a real HA instance with labels/areas configured is available, confirm label chips appear and filtering by area/label narrows the dropdown as expected; otherwise note in the commit message that this was verified structurally (types/build) but not against live labels data.

- [ ] **Step 9: Commit**

```bash
git add src/pages/ConfigEditor/ConfigEditor.tsx src/components/DoorList.tsx
git commit -m "feat: wire registry-aware picker, glow highlight, and swing preview into ConfigEditor Doors tab"
```

---

## Self-Review Notes

- **Spec coverage:** Feature 1 (glow highlight Task 1, swing preview Task 2, hover-vs-click trigger split Task 5/6) ✓. Feature 2 (registry fetch Task 3, device_class/area/label filtering + grouping + chips Task 4, DoorList wiring Task 5, mock entity Task 5, save-guard Task 6) ✓. All spec feedback items (overlap guard, highlight cleanup, device_class fallback, label OR, mock-save block, memoization) are addressed inline in their respective tasks.
- **Type consistency:** `highlightOpening`/`clearHighlight`/`previewSwing` names match between Tasks 1-2 (definition) and Task 6 (usage). `MOCK_CONTACT_ENTITY_ID` matches between Task 5 (definition) and Task 6 (import). `HARegistries`/`fetchRegistries`/`mergeEntityMetadata` match between Task 3 and Task 6. `DoorList` Props (`onClearHighlight`, `onPreviewSwing`, `labelRegistry`) match between Task 5 (declared) and Task 6 (passed).
- **Correction folded in:** Task 6 Step 4 shows the reasoning for *not* calling `previewSwing` from `onTest`, then supersedes the earlier draft in the same step — left both because a fresh implementer benefits from seeing why the naive version is wrong, not just the final answer.
