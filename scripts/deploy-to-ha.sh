#!/bin/sh
# Deploy 3Dash directly into a Home Assistant instance — no docker, no
# external hosting. The app is served by HA itself from config/www and
# appears as a sidebar panel that reuses the HA login session, so no
# device ever needs per-device setup.
#
# Usage:
#   ./scripts/deploy-to-ha.sh <ha-config-dir> [ha-base-url]
#
#   <ha-config-dir>  Path to the HA config directory (the one holding
#                    configuration.yaml), e.g. /config or ~/homeassistant.
#   [ha-base-url]    Public base URL of the HA instance, used for the
#                    optional standalone sign-in fallback (app-config.json).
#
# Afterwards add to configuration.yaml (once) and restart HA:
#
#   panel_custom:
#     - name: three-dash-panel
#       sidebar_title: 3Dash
#       sidebar_icon: mdi:cube-outline
#       url_path: 3dash
#       module_url: /local/3dash/panel.js?v=1
#       config:
#         url: /local/3dash/app/index.html?v=1
#
# The panel busts index.html's cache itself on every load; panel.js's own
# ?v= in module_url is rewritten to its content hash by this script (HA
# restart required when it changes, because /local/ is cached for 31 days).

set -e

CONFIG_DIR="$1"
HA_URL="$2"

if [ -z "$CONFIG_DIR" ]; then
  echo "usage: $0 <ha-config-dir> [ha-base-url]" >&2
  exit 1
fi

echo "Building (relative base path)..."
npm run build -- --mode addon

DEST="$CONFIG_DIR/www/3dash"
mkdir -p "$DEST/app"
rm -rf "$DEST/app"/*
cp -r dist/* "$DEST/app/"
cp ha/panel.js "$DEST/panel.js"

# Precompressed siblings: HA's aiohttp serves file.js.gz as Content-Encoding
# gzip when present. Vital on phones — the HA companion WebView won't cache
# multi-MB responses, so the 5.6MB Babylon chunk was re-downloaded on every
# app start; the ~1.2MB gzip variant transfers fast and caches.
find "$DEST/app" -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.svg' \) \
  -exec gzip -k9f {} +

if [ -n "$HA_URL" ]; then
  printf '{"haUrl":"%s"}' "$HA_URL" > "$DEST/app/app-config.json"
fi

# Rewrite the panel.js cache-bust version in configuration.yaml to the file's
# content hash, so stale copies can never survive a deploy.
YAML="$CONFIG_DIR/configuration.yaml"
if [ -f "$YAML" ] && grep -q '/local/3dash/panel.js' "$YAML"; then
  PANEL_V=$(md5sum ha/panel.js | cut -c1-8)
  if ! grep -q "panel.js?v=$PANEL_V" "$YAML"; then
    sed -i -E "s|(/local/3dash/panel\.js\?v=)[A-Za-z0-9]+|\1$PANEL_V|" "$YAML"
    echo "panel.js changed -> module_url bumped to ?v=$PANEL_V"
    echo "Restart Home Assistant to pick it up."
  fi
fi

echo "Deployed to $DEST"
echo "If this is the first install, add the panel_custom block from this"
echo "script's header to configuration.yaml and restart Home Assistant."
