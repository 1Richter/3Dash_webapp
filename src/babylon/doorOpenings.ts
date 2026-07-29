/**
 * Door & window opening detection + animation.
 *
 * SweetHome3D exports (OBJ/GLB) name the movable parts of doors and windows
 * with a stable convention so viewers can animate them:
 *
 *   sweethome3d_opening_on_hinge_<k>_door…_<idx>     door leaf
 *   sweethome3d_opening_on_hinge_<k>_handle…_<idx>   handles etc. (rotate along)
 *   sweethome3d_window_pane_on_hinge_<k>_<idx>       window casement pane
 *   sweethome3d_hinge_<k>_<n>_<idx>                  hinge marker meshes
 *
 * Exporters split meshes per material, so one physical leaf often appears as
 * several nodes with near-identical centers. Grouping is therefore spatial:
 * leaves whose centers almost coincide merge, remaining parts (handles,
 * clamps, …) attach to the nearest leaf, and the hinge axis comes from the
 * nearest stack of hinge markers (with a bounding-box-edge fallback when the
 * markers are missing or implausibly far).
 *
 * Detection runs in the editor; the resulting mesh names + pivot are stored
 * in DoorConfig so the dashboard can animate without re-detecting.
 */

import { Scene, AbstractMesh, TransformNode, Animation, QuadraticEase, EasingFunction, Vector3, HighlightLayer, Color3, Mesh } from '@babylonjs/core';
import type { DoorConfig } from '../types';

const OPENING_RE = /^sweethome3d_(opening_on_hinge|window_pane_on_hinge)_(\d+)(?:_(.*?))?_?(\d+)$/;
const HINGE_RE = /^sweethome3d_hinge_\d+(?:_\d+)?_\d+$/;

export interface DetectedOpening {
  /** Stable key: kind + leaf mesh's export index. */
  key: string;
  kind: 'door' | 'window';
  label: string;
  /** Meshes that rotate together (leaf + handles). */
  meshNames: string[];
  /** Vertical hinge axis position (world x/z). */
  pivot: { x: number; z: number };
}

interface Part {
  mesh: AbstractMesh;
  kind: 'door' | 'window';
  /** Descriptive middle segment of the name ('' for bare pane nodes). */
  partName: string;
  center: Vector3;
  isLeaf: boolean;
}

function worldCenter(mesh: AbstractMesh): Vector3 {
  return mesh.getBoundingInfo().boundingBox.centerWorld.clone();
}

function xzDist(a: Vector3, b: Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function leafSize(mesh: AbstractMesh): number {
  const bb = mesh.getBoundingInfo().boundingBox;
  const ext = bb.maximumWorld.subtract(bb.minimumWorld);
  return Math.max(ext.x, ext.z);
}

/** Scan the scene for SweetHome3D door/window openings. */
export function detectOpenings(scene: Scene): DetectedOpening[] {
  const parts: Part[] = [];
  const hingeMeshes: AbstractMesh[] = [];

  for (const mesh of scene.meshes) {
    if (mesh.getTotalVertices?.() === 0) continue;
    if (HINGE_RE.test(mesh.name)) {
      hingeMeshes.push(mesh);
      continue;
    }
    const m = OPENING_RE.exec(mesh.name);
    if (!m) continue;
    const kind = m[1] === 'opening_on_hinge' ? 'door' : 'window';
    const partName = m[3] ?? '';
    parts.push({
      mesh,
      kind,
      partName,
      center: worldCenter(mesh),
      // Door leaves carry "door" in the part name; window panes are the
      // bare sweethome3d_window_pane_on_hinge_<k>_<idx> nodes themselves.
      isLeaf: kind === 'door' ? /door/i.test(partName) : partName === '',
    });
  }
  const leaves = parts.filter(p => p.isLeaf);
  if (!leaves.length) return [];

  // Merge material-split leaves (near-identical centers, same kind)
  interface Group { kind: 'door' | 'window'; leaves: Part[]; others: Part[]; center: Vector3 }
  const groups: Group[] = [];
  for (const leaf of leaves) {
    const eps = Math.max(leafSize(leaf.mesh) * 0.35, 0.01);
    const g = groups.find(gr => gr.kind === leaf.kind && xzDist(gr.center, leaf.center) < eps);
    if (g) {
      g.leaves.push(leaf);
    } else {
      groups.push({ kind: leaf.kind, leaves: [leaf], others: [], center: leaf.center });
    }
  }

  // Attach non-leaf parts to the nearest group
  for (const p of parts) {
    if (p.isLeaf) continue;
    let best: Group | null = null;
    let bestD = Infinity;
    for (const g of groups) {
      const d = xzDist(g.center, p.center);
      if (d < bestD) { bestD = d; best = g; }
    }
    best?.others.push(p);
  }

  // Cluster hinge markers into vertical stacks (one stack per hinge line)
  interface Stack { x: number; z: number; n: number }
  const stacks: Stack[] = [];
  const stackEps = leaves.length ? Math.max(...leaves.map(l => leafSize(l.mesh))) * 0.3 : 0.3;
  for (const h of hingeMeshes) {
    const c = worldCenter(h);
    const s = stacks.find(st => Math.hypot(st.x - c.x, st.z - c.z) < stackEps);
    if (s) {
      s.x = (s.x * s.n + c.x) / (s.n + 1);
      s.z = (s.z * s.n + c.z) / (s.n + 1);
      s.n++;
    } else {
      stacks.push({ x: c.x, z: c.z, n: 1 });
    }
  }

  const openings: DetectedOpening[] = [];
  let doorNo = 0;
  let windowNo = 0;
  for (const g of groups) {
    const leafMesh = g.leaves[0].mesh;
    const size = leafSize(leafMesh);

    // Nearest hinge stack; reject stacks farther than the leaf plausibly reaches
    let pivot: { x: number; z: number } | null = null;
    let bestD = Infinity;
    for (const s of stacks) {
      const d = Math.hypot(s.x - g.center.x, s.z - g.center.z);
      if (d < bestD) { bestD = d; pivot = { x: s.x, z: s.z }; }
    }
    if (!pivot || bestD > size * 1.2) {
      // Fallback: vertical edge on the narrow side of the leaf's bounding box
      const bb = leafMesh.getBoundingInfo().boundingBox;
      const min = bb.minimumWorld, max = bb.maximumWorld;
      pivot = (max.x - min.x) > (max.z - min.z)
        ? { x: min.x, z: (min.z + max.z) / 2 }
        : { x: (min.x + max.x) / 2, z: min.z };
    }

    const label = g.kind === 'door' ? `Door ${++doorNo}` : `Window ${++windowNo}`;
    openings.push({
      key: `${g.kind}-${g.leaves[0].mesh.name}`,
      kind: g.kind,
      label,
      meshNames: [...g.leaves, ...g.others].map(p => p.mesh.name),
      pivot,
    });
  }
  return openings.sort((a, b) => a.label.localeCompare(b.label));
}

/* ── Animation ── */

const pivotNodes = new Map<string, TransformNode>();

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

function pivotFor(scene: Scene, door: DoorConfig): TransformNode | null {
  const cached = pivotNodes.get(door.id);
  if (cached && !cached.isDisposed()) return cached;

  const meshes = door.meshNames
    .map(n => scene.getMeshByName(n))
    .filter((m): m is AbstractMesh => !!m);
  if (!meshes.length) return null;

  const node = new TransformNode(`door-pivot-${door.id}`, scene);
  node.position = new Vector3(door.pivot.x, 0, door.pivot.z);
  for (const m of meshes) m.setParent(node, true);
  pivotNodes.set(door.id, node);
  return node;
}

/** Forget cached pivots (call on scene dispose/rebuild). */
export function resetDoorPivots(): void {
  pivotNodes.clear();
  highlightLayer = null;
  highlightedMeshNames = [];
  if (highlightTimer) {
    clearTimeout(highlightTimer);
    highlightTimer = null;
  }
}

/**
 * Rotate a door/window to its open or closed pose.
 * Idempotent — re-applying the same state does nothing visually.
 */
export function applyDoorState(
  scene: Scene,
  door: DoorConfig,
  open: boolean,
  animate = true,
): void {
  const node = pivotFor(scene, door);
  if (!node) return;
  const angleDeg = (door.openAngle ?? 80) * (door.invert ? -1 : 1);
  const target = open ? (angleDeg * Math.PI) / 180 : 0;
  if (Math.abs(node.rotation.y - target) < 1e-4) return;

  if (!animate) {
    node.rotation.y = target;
    return;
  }
  const fps = 30;
  const anim = new Animation(`door-${door.id}`, 'rotation.y', fps,
    Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CONSTANT);
  anim.setKeys([
    { frame: 0, value: node.rotation.y },
    { frame: fps * 0.7, value: target },
  ]);
  const ease = new QuadraticEase();
  ease.setEasingMode(EasingFunction.EASINGMODE_EASEINOUT);
  anim.setEasingFunction(ease);
  scene.beginDirectAnimation(node, [anim], 0, fps * 0.7, false);
}
