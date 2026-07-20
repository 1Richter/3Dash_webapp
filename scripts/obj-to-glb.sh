#!/bin/sh
# Convert a SweetHome3D "Export to Home Assistant" OBJ into a GLB usable by
# 3Dash, with per-group node names preserved (needed for ZoneMeshFilter,
# per-zone modelKey, and door/window detection - all of which match on mesh
# name).
#
# Two steps, chained automatically:
#   1. Blender (headless) imports the .obj with use_split_groups=true and
#      exports a GLB. gltfpack's own .obj importer collapses every group
#      into one unnamed mesh, so it cannot do this step.
#   2. gltfpack compresses that GLB with 3Dash's standard flags (same as
#      `npm run optimize-model`), unless -raw is passed.
#
# Usage:
#   ./scripts/obj-to-glb.sh -i home.obj -o model.glb [-raw]
#
# Caveat (found 2026-07-20 on a merged two-level export): SweetHome3D/the HA
# floor-plan plugin names each furniture piece's *primary* mesh with a
# floor+object prefix (e.g. lvl000Flachbildfernseher_1), but multi-part
# furniture's secondary parts export as bare numbers (1, 2, 3...) with no
# floor tag. A mesh-prefix zone filter will hide those parts on every floor.
# For multi-story buildings, export each level separately (hide the other
# level in SweetHome3D's Plan view before exporting) and load them as
# separate per-zone models (Settings > Zones > Upload own model) instead of
# relying on ZoneMeshFilter against one merged export.

set -e

BLENDER_BIN="${BLENDER_BIN:-}"
RAW=0
IN=""
OUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    -i) IN="$2"; shift 2 ;;
    -o) OUT="$2"; shift 2 ;;
    -raw) RAW=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$IN" ] || [ -z "$OUT" ]; then
  echo "usage: $0 -i <input.obj> -o <output.glb> [-raw]" >&2
  exit 1
fi

if [ -z "$BLENDER_BIN" ]; then
  for candidate in \
    "$(command -v blender 2>/dev/null)" \
    "/c/Program Files/Blender Foundation/Blender 5.1/blender.exe" \
    "/c/Program Files/Blender Foundation/Blender 4.2/blender.exe" \
    "/Applications/Blender.app/Contents/MacOS/Blender" \
    "/usr/bin/blender"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      BLENDER_BIN="$candidate"
      break
    fi
  done
fi

if [ -z "$BLENDER_BIN" ]; then
  echo "Blender not found. Install it, or set BLENDER_BIN=/path/to/blender." >&2
  exit 1
fi

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
TMP_GLB="$(mktemp -u).glb"

echo "Importing $IN via Blender ($BLENDER_BIN)..."
"$BLENDER_BIN" --background --python "$SCRIPT_DIR/obj2glb.py" -- "$IN" "$TMP_GLB"

if [ "$RAW" = "1" ]; then
  mv "$TMP_GLB" "$OUT"
  echo "Wrote uncompressed $OUT"
else
  echo "Compressing with gltfpack..."
  npx gltfpack -cc -vpf -kn -km -ke -i "$TMP_GLB" -o "$OUT"
  rm -f "$TMP_GLB"
  echo "Wrote $OUT"
fi
