# Door/Window Editor Upgrade — Design

Date: 2026-07-29
Stack: Babylon.js (not Three.js/R3F — corrected from initial request), React, TypeScript.

## Context

`ConfigEditor.tsx` → Doors tab already has a working foundation:
- `src/babylon/doorOpenings.ts`: `detectOpenings()` finds SweetHome3D-named door/window
  meshes; `applyDoorState()` does an eased hinge-rotation swing via Babylon `Animation`.
- `src/components/DoorList.tsx`: lists detected + bound openings, has a bounding-box
  "highlight" flash (⌖ button), manual Open/Close test toggle, invert + angle controls.
- `src/components/EntityPicker.tsx`: generic searchable combobox already used elsewhere,
  but the door binder currently uses a plain `<select>` instead of it.
- `haEntities` (ConfigEditor.tsx ~L82-121) comes from a WS `subscribe_entities` call and
  only carries `entity_id` + `friendly_name` — no `device_class`, area, or labels.

This spec covers closing the gaps, not rebuilding what already works.

## Feature 1 — 3D highlight + swing preview

**Highlight:** replace the `showBoundingBox` flash in `doorOpenings.ts` with a Babylon
`HighlightLayer` (green glow), scoped to the opening's `meshNames`. Exported as
`highlightOpening(scene, meshNames, durationMs = 1800)`.

**Swing preview:** new `previewSwing(scene, door)` in `doorOpenings.ts` — calls
`applyDoorState(scene, door, true)`, waits ~900ms, then `applyDoorState(scene, door, false)`.
Reuses the existing eased animation, no new animation code.

**Triggers (`DoorList.tsx`):**
- Row `onMouseEnter` → glow only (`highlightOpening`). No swing on hover — 20+ doors
  swinging on casual mouse-over would be distracting and could hammer real hardware if
  ever wired to optimistic state.
- "Bind contact sensor" selection and the existing "Test swing" button → glow + `previewSwing`.
- Existing manual Open/Close toggle for bound doors is unchanged (it's a persistent
  preview state, not a one-shot animation, and must survive independent of hover).

- ANimation Overlap: Specify that previewSwing must clear any existing timeouts for that specific  
  door before starting a new one, or block the animation if one is currently playing.
- Animation Timing: The spec says "waits ~900ms, then applyDoorState... (false)". 
  Ensure that 900ms is actually longer than the easing duration inside applyDoorState. 
  If the open animation takes 1000ms to complete, firing the close command at 900ms will interrupt it abruptly.

- Highlight Memory/Cleanup: HighlightLayer in Babylon can be computationally expensive if misused.
  Fix: Explicitly state that onMouseLeave must remove the mesh from the HighlightLayer cleanly. If a user quickly drags their mouse across all 20 doors, you don't want orphaned highlighted meshes left behind due to race conditions.


## Feature 2 — Smart contact-sensor picker

**Registry data:** new `src/ha/registries.ts` (mirrors `HAConnection` usage patterns from
ConfigEditor.tsx). Fetches, once, lazily when the Doors tab is first opened:
- `config/entity_registry/list` → `device_class` (fallback to state attribute if entity
  registry omits it), `area_id`, `labels`.
- `config/area_registry/list` → `area_id` → `name` map.
- `config/label_registry/list` → `label_id` → `{name, color}` map.

Cached in `ConfigEditor.tsx` state alongside `haEntities`, same cache-first pattern as the
existing entity load effect.

**Type change:** `HAEntityOption` (`EntityPicker.tsx`) gains optional `device_class`,
`area_id`, `area_name`, `labels?: string[]`. Backward compatible — every other consumer of
`EntityPicker` ignores the new fields.

**`EntityPicker` additions** (used by `DoorList.tsx` in place of the plain `<select>`):
- Default filter predicate: `domain === 'binary_sensor' && device_class ∈ {door, window,
  garage_door}`. A "show all" checkbox above the search input disables the predicate for
  edge cases (template sensors, non-standard device classes).
- Results grouped by `area_name` (entities with no area under an "Other" group).
- Label chips row above the dropdown, sourced from label registry; click toggles a chip
  into an active-filter set (AND across selected chips). Chips only shown for labels that
  appear on at least one candidate entity.

- The device_class Fallback Trap: You correctly noted that device_class is sometimes missing from the entity registry and must fall back to the state attribute. However, subscribe_entities usually only provides the basic state (unless it's the initial full state dump).

  Fix: Ensure the prompt specifies that the merging logic must actively look at haEntities[id].attributes.device_class if registry.device_class is null.

- Label Filtering Logic (AND vs. OR): The spec notes "(AND across selected chips)". While AND is good for strict filtering (e.g., ground_floor AND security), users often expect OR behavior when clicking multiple tags (e.g., show me doors in ground_floor OR garage).

  **Decision: OR.** Labels describe orthogonal facets (area-ish tags, security tags, etc.),
  not a strict taxonomy — AND would empty the list too easily with 2+ clicks. Selected
  chips union their matches; entities matching any active chip are shown.


**Mock entity:** a synthetic `binary_sensor.mock_contact_demo` (`device_class: 'door'`,
`friendly_name: 'Demo Contact Sensor (mock)'`) is injected client-side only into the
entities array passed to the door picker — never sent to HA, never persisted in
`DoorConfig` differently from a real entity_id. A small toggle switch next to it in the
results list flips a local synthetic on/off state and drives the same `previewSwing` path,
so the whole highlight/swing loop is testable with zero physical hardware.

- Saving the Mock Entity: The spec states the mock sensor is "never persisted in DoorConfig differently from a real entity_id." This means if you bind the mock sensor and hit "Save", binary_sensor.mock_contact_demo will be written to your configuration JSON/database.

  The Issue: When the main dashboard loads, it will try to subscribe to binary_sensor.mock_contact_demo via the WebSocket, which will throw a "not found" warning in your console or HA logs.

  **Decision: (A).** ConfigEditor's save path strips any door bound to `binary_sensor.mock_contact_demo`
  (or warns and refuses to save while a mock binding is active — save button disabled with
  inline hint until it's rebound to a real entity or removed). Dashboard code stays untouched;
  the mock never leaves the editor.

## Data flow

```
ConfigEditor (Doors tab opens)
  → registries.ts fetch (entity/area/label registry, lazy + cached)
  → merged into haEntities (device_class/area/labels attached)
  → DoorList
      → EntityPicker (filtered/grouped/chip-filtered)
          → bind → onChange(doors) → ConfigEditor state → saved config
      → row hover / test button → ConfigEditor.handleHighlightOpening /
        handleTestDoor → doorOpenings.ts (highlightOpening / previewSwing)
```

## Error handling / edge cases

- No HA connection / offline mode: registry fetch simply doesn't run (same guard as the
  existing entity-list effect); picker falls back to unfiltered `haEntities` (today's
  behavior) plus the mock entity, so the UI is still usable and testable.
- Registry fetch failure (WS error): swallow, log to console, proceed with whatever
  `haEntities` already has (no device_class/area/labels — picker behaves like today).
- Zero matching contact-sensor entities after filtering: "show all" toggle is the escape
  hatch; empty state text updates to mention it.

## Out of scope

- No changes to `DoorConfig` persistence shape.
- No changes to dashboard-side (non-editor) door rendering.
- No real HA entity creation for the mock sensor — purely client-side UI sugar.

## REact Performanc (Memoization)
- DoorList: Each row should be memoized to avoid unnecessary re-renders when the list of doors is updated. Use React.memo and ensure that the props passed to each row are stable (e.g., useCallback for event handlers).
- EntityPicker: The filtering and grouping logic should be memoized using useMemo to avoid recalculating the filtered list on every render. This is especially important if the list of entities is large.
Large Registries: Home Assistant registries can contain thousands of items. Merging the entity registry, area registry, label registry, and the live haEntities state on the fly can cause massive re-renders for a list of 20+ doors.

Fix: Instruct the LLM to aggressively memoize (useMemo) the merged entity list and the EntityPicker components so that an update to one door's configuration doesn't force all 20 EntityPicker dropdowns to recalculate the merged array.