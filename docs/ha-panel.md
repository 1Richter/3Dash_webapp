# Zero-setup access: 3Dash as a Home Assistant panel

Goal: configure the dashboard **once**, then every device that is logged into
Home Assistant gets the finished 3D dashboard — no token pasting, no OAuth
redirect, no per-device onboarding.

## How it works

`ha/panel.js` is a small Home Assistant *custom panel* that embeds the 3Dash
app in an iframe and forwards the HA session's short-lived access token to it
over `postMessage`:

```
app    → panel : {type:'3dash-ready'}                        on boot (retries)
panel  → app   : {type:'3dash-auth', hassUrl, accessToken, expiresAt}
app    → panel : {type:'3dash-token-request'}                near expiry
```

The app (`src/services/embeddedAuth.ts`) pins the first sender's origin,
configures itself for HA-hosted sync (config via `frontend/set_user_data`,
model via `/local/3dash/model.glb`) and authenticates its WebSocket through a
token provider that transparently refreshes via the parent. The HA frontend
keeps the token fresh, so sessions never expire while HA is open.

## Install options

### A. Served by Home Assistant itself (no extra hosting)

```sh
./scripts/deploy-to-ha.sh /path/to/ha/config https://your-ha.example.net
```

Then add to `configuration.yaml` and restart HA:

```yaml
panel_custom:
  - name: three-dash-panel
    sidebar_title: 3Dash
    sidebar_icon: mdi:cube-outline
    url_path: 3dash
    module_url: /local/3dash/panel.js?v=1
    config:
      url: /local/3dash/app/index.html?v=1
```

Everything (panel, app, model, config) is served from the HA origin — works
in browsers and the companion apps, internal or external URL, no CORS setup.

Bump both `?v=` values after each redeploy (HA serves `/local/` with a
31-day cache).

### B. Self-hosted app (docker/nginx)

Host the built app anywhere (see the compose example in `docs/ha-sync.md`),
keep the same `panel_custom` block but point `config.url` at your app URL,
e.g. `https://3dash.example.net/`. Add your app origin to
`http.cors_allowed_origins` in HA for the WebSocket + model fetch.

## Fallbacks outside the panel

- Deployments can serve an `app-config.json` (`{"haUrl": "https://…"}`) next
  to `index.html`; unconfigured devices visiting the app directly are then
  forwarded to the HA OAuth sign-in automatically ("Sign in with Home
  Assistant") and land on the finished dashboard after approving once.
- The manual wizard (URL + long-lived token) remains available behind
  "Set up manually".
