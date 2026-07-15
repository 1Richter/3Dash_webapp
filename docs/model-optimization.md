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
