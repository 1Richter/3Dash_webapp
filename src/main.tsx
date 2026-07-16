import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import { completeOAuthLogin } from './services/haAuth';
import { initEmbeddedAuth, configureFromEmbeddedAuth } from './services/embeddedAuth';
import { reloadWithReason, markBoot } from './services/bootTrace';
import App from './App';
import './App.css';

// Resolve authentication before the router sees the URL:
// 1. Embedded in the HA custom panel → adopt the HA session's token.
// 2. URL carries an OAuth code from Home Assistant → finish that login.
(async () => {
  markBoot('js');
  try {
    if (await initEmbeddedAuth()) configureFromEmbeddedAuth();
  } catch (e) {
    console.error('[embeddedAuth] failed:', e);
  }
  try {
    await completeOAuthLogin();
  } catch (e) {
    console.error('[haAuth] Sign in with Home Assistant failed:', e);
  }
})()
  .finally(() => {
    markBoot('auth');
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <App />
        </HashRouter>
      </StrictMode>,
    );
  });

// Service worker: only for standalone hosting. When the app is served from
// Home Assistant's /local/ folder, HA sends 31-day cache headers that also
// pin sw.js itself, so a service worker would trap clients on stale builds.
// There, hashed assets + the panel's ?v= cache-busting handle caching.
const servedFromHA = window.location.pathname.includes('/local/');
if (servedFromHA) {
  navigator.serviceWorker?.getRegistrations().then(async (regs) => {
    if (!regs.length) return;
    for (const r of regs) await r.unregister();
    for (const k of await caches.keys()) await caches.delete(k);
    // Detach this page from the stale worker exactly once
    if (navigator.serviceWorker.controller && !sessionStorage.getItem('3dash_sw_purged')) {
      sessionStorage.setItem('3dash_sw_purged', '1');
      reloadWithReason('sw-purge', 0);
    }
  });
} else {
  // Auto-update when a new version is available; also poll hourly so
  // long-lived wall-mounted dashboards pick up new builds.
  registerSW({
    immediate: true,
    onRegisteredSW(_url, registration) {
      if (registration) setInterval(() => registration.update(), 60 * 60 * 1000);
    },
  });
}
