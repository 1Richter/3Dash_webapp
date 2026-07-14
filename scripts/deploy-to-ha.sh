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
# Bump both ?v= numbers after each deploy so browsers refetch past HA's
# 31-day static cache.

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

if [ -n "$HA_URL" ]; then
  printf '{"haUrl":"%s"}' "$HA_URL" > "$DEST/app/app-config.json"
fi

echo "Deployed to $DEST"
echo "If this is the first install, add the panel_custom block from this"
echo "script's header to configuration.yaml and restart Home Assistant."
