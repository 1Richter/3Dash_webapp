import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import { completeOAuthLogin } from './services/haAuth';
import { initEmbeddedAuth, configureFromEmbeddedAuth } from './services/embeddedAuth';
import App from './App';
import './App.css';

// Resolve authentication before the router sees the URL:
// 1. Embedded in the HA custom panel → adopt the HA session's token.
// 2. URL carries an OAuth code from Home Assistant → finish that login.
(async () => {
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
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <App />
        </HashRouter>
      </StrictMode>,
    );
  });

// Auto-update service worker when new version is available; also poll
// hourly so long-lived wall-mounted dashboards pick up new builds.
registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (registration) setInterval(() => registration.update(), 60 * 60 * 1000);
  },
});
