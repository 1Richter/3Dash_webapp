# Model optimization (fast loads on mobile)

Large `.glb` exports (10-50 MB straight out of Blender/SketchUp) dominate
3Dash's startup time — on a phone over a typical home upload link a 18 MB
model alone takes 30-40 s. Compressing it with
[gltfpack](https://github.com/zeux/meshoptimizer/tree/master/gltf) (meshopt,
`EXT_meshopt_compression`) typically shrinks it 4-8x with no visible loss.

## Usage

```bash
npm run optimize-model -- -i my-house.glb -o model.glb
```

Then use `model.glb` wherever you deployed the original (device upload,
`config/www/3dash/model.glb` on Home Assistant, …).

The script wraps `gltfpack` with flags chosen for 3Dash:

| Flag | Why |
|------|-----|
| `-cc` | meshopt compression (the actual size win) |
| `-vpf` | keep positions as floats — light/zone coordinates in your config are absolute, quantized positions would shift geometry relative to them |
| `-kn` | keep node names (mesh lookups by name) |
| `-km` | keep materials |
| `-ke` | keep extras (custom properties survive) |

## Runtime support

The app decodes `EXT_meshopt_compression` with the decoder bundled from the
`meshoptimizer` npm package (`src/babylon/meshoptSupport.ts`). No CDN, no
network dependency — offline/LAN-only deployments keep working. Uncompressed
models load exactly as before; nothing about the upload or sync flow changes.

## Repeat loads

Models are cached in IndexedDB and revalidated by ETag, so the download cost
is first-load only. The optimization above is about that first load — and
about any device where the browser evicts storage (iOS Safari does this
aggressively).

## Converting from SweetHome3D / HA floor-plan OBJ exports

The "Export to Home Assistant" plugin (shmuelzon/home-assistant-floor-plan)
produces an `.obj`, not a `.glb`. Don't feed it to `gltfpack` directly — its
built-in OBJ importer collapses every named group into a single unnamed mesh,
which breaks mesh-name-based features (`ZoneMeshFilter`, per-zone
`modelKey`, door/window detection in `src/babylon/doorOpenings.ts`).

```bash
npm run convert-model -- -i home.obj -o model.glb
```

This runs `scripts/obj-to-glb.sh`, which imports the OBJ in headless Blender
with `use_split_groups=true` (needed to keep each group as its own named
node — Blender's default merges them too) and pipes the result through
`gltfpack` with the same flags as `optimize-model`. Requires Blender
installed locally (`BLENDER_BIN=/path/to/blender` to override auto-detection).

**Multi-story caveat** (found 2026-07-20): the plugin reliably prefixes
walls, rooms, and each furniture piece's *primary* mesh with a floor tag
(`lvl000…`, `lvl001…`), but a multi-part furniture item's secondary parts
export with bare generic names (`1`, `2`, `3`…) shared across floors — no
floor tag at all. A `ZoneMeshFilter` on one merged multi-level export will
hide those parts on every floor. For multi-story buildings, export each
level separately in SweetHome3D (hide the other level in the Plan view
before exporting) and attach the second floor as its own model via
Settings → Zones → "Upload own model" (`ZoneConfig.modelKey`) instead of
merging levels into one file.
