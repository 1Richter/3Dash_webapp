import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { getRuntimeDefaults, startOAuthLogin } from '../../services/haAuth';
import {
  isEmbedded,
  hasEmbeddedAuth,
  onEmbeddedAuth,
  configureFromEmbeddedAuth,
} from '../../services/embeddedAuth';

/**
 * Landing page for unconfigured devices.
 *
 * Embedded in the HA custom panel: wait for the parent to deliver the HA
 * session token (it may arrive late on slow devices), then reload into the
 * dashboard — never redirect away, that would hijack the HA frontend.
 *
 * Standalone with a deployment-declared HA URL (app-config.json): forward
 * straight to the HA sign-in. Otherwise: manual onboarding wizard.
 */
const TRIED_KEY = '3dash_auto_auth_tried';

export default function AutoConnect() {
  const navigate = useNavigate();
  const embedded = isEmbedded();
  // undefined = loading, null = no deployment default → manual onboarding
  const [haUrl, setHaUrl] = useState<string | null | undefined>(undefined);
  const [autoTried] = useState(() => sessionStorage.getItem(TRIED_KEY) === '1');
  const [stuck, setStuck] = useState(false);

  // Embedded: surface troubleshooting options when no token arrives
  useEffect(() => {
    if (!embedded) return;
    const t = setTimeout(() => setStuck(true), 15000);
    return () => clearTimeout(t);
  }, [embedded]);

  // Embedded: adopt the HA session as soon as the parent panel delivers it
  useEffect(() => {
    if (!embedded) return;
    const adopt = () => {
      configureFromEmbeddedAuth();
      // Land on the dashboard after the reload — reloading at #/welcome
      // would re-enter this page and loop.
      window.location.hash = '#/';
      window.location.reload();
    };
    if (hasEmbeddedAuth()) {
      adopt();
      return;
    }
    return onEmbeddedAuth(adopt);
  }, [embedded]);

  useEffect(() => {
    if (embedded) return;
    getRuntimeDefaults().then((d) => {
      const url = d.haUrl || null;
      setHaUrl(url);
      if (url && !autoTried) {
        // Only auto-forward once per session so a cancelled login
        // doesn't bounce the user back and forth.
        sessionStorage.setItem(TRIED_KEY, '1');
        startOAuthLogin(url);
      }
    });
  }, [autoTried, embedded]);

  if (embedded) {
    return (
      <div className="onboarding-step" style={{ textAlign: 'center', paddingTop: '20vh' }}>
        <h1>3Dash</h1>
        <h2>Connecting to your Home Assistant session…</h2>
        {stuck ? (
          <>
            <p>
              Still waiting for the Home Assistant panel to hand over the session.
              The panel script may be outdated or cached.
            </p>
            <button className="onboarding-btn primary" onClick={() => window.location.reload()}>
              Retry
            </button>
            <p style={{ marginTop: 16 }}>
              <button className="onboarding-btn" onClick={() => navigate('/onboarding', { replace: true })}>
                Set up manually instead
              </button>
            </p>
          </>
        ) : (
          <p>This usually takes a second.</p>
        )}
      </div>
    );
  }

  if (haUrl === undefined) return null;
  if (haUrl === null) return <Navigate to="/onboarding" replace />;

  return (
    <div className="onboarding-step" style={{ textAlign: 'center', paddingTop: '20vh' }}>
      <h1>3Dash</h1>
      {autoTried ? (
        <>
          <h2>Sign in to continue</h2>
          <p>This dashboard is linked to {haUrl.replace(/^https?:\/\//, '')}.</p>
          <button className="onboarding-btn primary" onClick={() => startOAuthLogin(haUrl)}>
            Sign in with Home Assistant
          </button>
          <p style={{ marginTop: 16 }}>
            <button className="onboarding-btn" onClick={() => navigate('/onboarding', { replace: true })}>
              Set up manually instead
            </button>
          </p>
        </>
      ) : (
        <h2>Redirecting to Home Assistant sign-in…</h2>
      )}
    </div>
  );
}
