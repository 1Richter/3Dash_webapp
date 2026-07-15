/**
 * EXT_meshopt_compression support for glTF/GLB models.
 *
 * Babylon's default MeshoptCompression lazy-loads its decoder script from
 * cdn.babylonjs.com, which breaks on offline/LAN-only deployments and adds a
 * runtime network dependency. Instead we bundle the decoder from the
 * `meshoptimizer` npm package and install it as Babylon's default decoder.
 *
 * Models compressed with `npm run optimize-model` (gltfpack) load 3-10x
 * faster on slow connections — see docs/model-optimization.md.
 */
import { MeshoptCompression } from '@babylonjs/core';
import { MeshoptDecoder } from 'meshoptimizer';

let installed = false;

/** Install the bundled meshopt decoder as Babylon's default (idempotent). */
export function installMeshoptDecoder(): void {
  if (installed) return;
  installed = true;
  const decoder: Pick<MeshoptCompression, 'decodeGltfBufferAsync' | 'dispose'> = {
    async decodeGltfBufferAsync(
      source: Uint8Array,
      count: number,
      stride: number,
      mode: string,
      filter?: string,
    ): Promise<Uint8Array> {
      await MeshoptDecoder.ready;
      return MeshoptDecoder.decodeGltfBufferAsync(
        count,
        stride,
        source,
        mode as Parameters<typeof MeshoptDecoder.decodeGltfBufferAsync>[3],
        filter,
      );
    },
    dispose(): void { /* nothing to release — decoder is a bundled module */ },
  };
  // MeshoptCompression.Default has no public setter; _Default is the backing
  // field its getter returns when non-null.
  (MeshoptCompression as unknown as { _Default: unknown })._Default = decoder;
}
