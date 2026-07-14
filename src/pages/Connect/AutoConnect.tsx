import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { getRuntimeDefaults, startOAuthLogin } from '../../services/haAuth';

/**
 * Landing page for unconfigured devices on deployments that declare their
 * Home Assistant URL (app-config.json). Immediately forwards to the HA
 * sign-in — a new phone only has to tap "approve" on its HA login. Falls
 * back to the manual onboarding wizard when no default URL is configured
 * or when a previous auto sign-in attempt didn't complete.
 */
const TRIED_KEY = '3dash_auto_auth_tried';

export default function AutoConnect() {
  const navigate = useNavigate();
  // undefined = loading, null = no deployment default → manual onboarding
  const [haUrl, setHaUrl] = useState<string | null | undefined>(undefined);
  const [autoTried] = useState(() => sessionStorage.getItem(TRIED_KEY) === '1');

  useEffect(() => {
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
  }, [autoTried]);

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
