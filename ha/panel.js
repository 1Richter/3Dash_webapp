/**
 * 3Dash custom panel for Home Assistant.
 *
 * Embeds the 3Dash web app and forwards the HA session's access token to it,
 * so any device that is logged into Home Assistant gets a fully working
 * dashboard with zero per-device setup.
 *
 * Install:
 *   1. Copy this file to config/www/3dash/panel.js
 *   2. Add to configuration.yaml (adjust the app URL if self-hosted elsewhere):
 *
 *      panel_custom:
 *        - name: three-dash-panel
 *          sidebar_title: 3Dash
 *          sidebar_icon: mdi:cube-outline
 *          url_path: 3dash
 *          module_url: /local/3dash/panel.js?v=1
 *          config:
 *            url: https://3dash.example.net/
 *
 *   3. Restart Home Assistant.
 */

class ThreeDashPanel extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._iframe = null;
    this._appOrigin = null;
  }

  // HA calls this with panel_custom's `config:` block. `url` may be absolute
  // (self-hosted app) or relative (app served from HA's own /local/ folder).
  set panel(panel) {
    const url = (panel && panel.config && panel.config.url) || '/local/3dash/app/index.html';
    // HA serves /local/ with 31-day cache headers. A per-load cache-buster on
    // index.html keeps every device on the newest build (the heavy assets are
    // content-hashed, so they still cache normally).
    const u = new URL(url, window.location.origin);
    u.searchParams.set('cb', Date.now().toString(36));
    this._appUrl = u.toString();
    this._appOrigin = u.origin;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._sendAuth();
  }

  connectedCallback() {
    this._render();
  }

  _render() {
    if (this._iframe || !this._appUrl) return;
    const root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = ':host{display:block;height:100%}iframe{border:0;width:100%;height:100%;display:block}';
    this._iframe = document.createElement('iframe');
    this._iframe.src = this._appUrl;
    this._iframe.allow = 'fullscreen';
    root.append(style, this._iframe);

    window.addEventListener('message', (e) => {
      if (
        this._iframe &&
        e.source === this._iframe.contentWindow &&
        e.data &&
        (e.data.type === '3dash-ready' || e.data.type === '3dash-token-request')
      ) {
        this._sendAuth();
      }
    });
    this._iframe.addEventListener('load', () => this._sendAuth());
    // Proactive resend: covers races and webviews (companion app) where the
    // app's ready message can be missed. Cheap — the app ignores duplicates.
    setInterval(() => this._sendAuth(), 3000);
  }

  _sendAuth() {
    if (!this._hass || !this._iframe || !this._iframe.contentWindow) return;
    const auth = this._hass.auth;
    if (!auth) return;

    // Companion apps use an external auth object — refresh through it when
    // the current token is expired instead of forwarding a dead one.
    if (auth.expired && typeof auth.refreshAccessToken === 'function') {
      if (!this._refreshing) {
        this._refreshing = true;
        auth.refreshAccessToken()
          .then(() => { this._refreshing = false; this._sendAuth(); })
          .catch((err) => { this._refreshing = false; console.warn('3dash-panel: token refresh failed', err); });
      }
      return;
    }

    const token = auth.accessToken || (auth.data && auth.data.access_token);
    if (!token) {
      console.warn('3dash-panel: no access token available yet');
      return;
    }
    this._iframe.contentWindow.postMessage(
      {
        type: '3dash-auth',
        hassUrl: (auth.data && auth.data.hassUrl) || window.location.origin,
        accessToken: token,
        expiresAt: auth.data && typeof auth.data.expires === 'number' ? auth.data.expires : undefined,
      },
      this._appOrigin,
    );
  }
}

customElements.define('three-dash-panel', ThreeDashPanel);
