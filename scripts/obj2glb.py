"""
Blender headless helper: import a SweetHome3D/HA-floor-plan OBJ export and
write a GLB with one node per OBJ group ('g' line).

Why this exists: gltfpack accepts .obj input directly, but its own OBJ
importer collapses every group into a single unnamed mesh - useless for
per-floor / per-object mesh filtering (ZoneMeshFilter, door detection).
Blender's importer keeps groups as separate objects, but only if
use_split_groups is explicitly enabled (its default merges them too).

Run via scripts/obj-to-glb.sh, not directly - it locates the Blender binary
and chains this with gltfpack compression.
"""
import bpy
import sys

argv = sys.argv[sys.argv.index("--") + 1:]
obj_path, glb_path = argv[0], argv[1]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.obj_import(filepath=obj_path, use_split_groups=True, use_split_objects=True)

print(f"[obj2glb] imported {len(bpy.data.objects)} objects")

bpy.ops.export_scene.gltf(
    filepath=glb_path,
    export_format='GLB',
    export_apply=True,
    export_yup=True,
)
print(f"[obj2glb] wrote {glb_path}")
