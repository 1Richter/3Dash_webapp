import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import { completeOAuthLogin } from './services/haAuth';
import App from './App';
import './App.css';

// If the URL carries an OAuth code from Home Assistant, finish the login
// (saves tokens + configures HA sync) before the router sees the URL.
completeOAuthLogin()
  .catch((e) => console.error('[haAuth] Sign in with Home Assistant failed:', e))
  .finally(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <App />
        </HashRouter>
      </StrictMode>,
    );
  });

// Auto-update service worker when new version is available
registerSW({ immediate: true });
