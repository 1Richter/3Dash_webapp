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

  // HA calls this with panel_custom's `config:` block
  set panel(panel) {
    this._appUrl = (panel && panel.config && panel.config.url) || 'https://3dash.lrichter.net/';
    this._appOrigin = new URL(this._appUrl).origin;
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
  }

  _sendAuth() {
    if (!this._hass || !this._iframe || !this._iframe.contentWindow) return;
    const auth = this._hass.auth && this._hass.auth.data;
    if (!auth || !auth.access_token) return;
    this._iframe.contentWindow.postMessage(
      {
        type: '3dash-auth',
        hassUrl: auth.hassUrl || window.location.origin,
        accessToken: auth.access_token,
        expiresAt: typeof auth.expires === 'number' ? auth.expires : undefined,
      },
      this._appOrigin,
    );
  }
}

customElements.define('three-dash-panel', ThreeDashPanel);
