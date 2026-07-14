import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { DemoModeProvider } from './contexts/DemoModeContext';
import { SimulationModeProvider, useSimulationMode } from './contexts/SimulationModeContext';
import { CameraControlsProvider } from './contexts/CameraControlsContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { hasConfig, getConfig } from './services/configApi';
import Dashboard from './pages/Dashboard/Dashboard';

const ConfigEditor = lazy(() => import('./pages/ConfigEditor/ConfigEditor'));
const Onboarding = lazy(() => import('./pages/Onboarding/Onboarding'));
const Connect = lazy(() => import('./pages/Connect/Connect'));
const AutoConnect = lazy(() => import('./pages/Connect/AutoConnect'));

function AppRoutes() {
  const location = useLocation();
  const { simulationMode } = useSimulationMode();

  // No config at all → onboarding. Config exists but not completed → onboarding.
  const configExists = hasConfig();
  const onboardingDone = configExists && (getConfig().onboarding?.completed ?? false);

  // Unconfigured devices land on /welcome: deployments that declare their HA
  // URL forward straight to the HA sign-in, others fall through to onboarding.
  // (Simulation mode and the one-tap /connect link bypass this.)
  const setupRoutes = ['/onboarding', '/connect', '/welcome'];
  if (!onboardingDone && !simulationMode && !setupRoutes.includes(location.pathname)) {
    return <Navigate to="/welcome" replace />;
  }
  // Configured devices have no business on the auto-connect page (a stale
  // #/welcome hash after setup would loop) — send them to the dashboard.
  if (onboardingDone && location.pathname === '/welcome') {
    return <Navigate to="/" replace />;
  }

  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/editor" element={<Suspense fallback={null}><ConfigEditor /></Suspense>} />
      <Route path="/onboarding" element={<Suspense fallback={null}><Onboarding /></Suspense>} />
      <Route path="/connect" element={<Suspense fallback={null}><Connect /></Suspense>} />
      <Route path="/welcome" element={<Suspense fallback={null}><AutoConnect /></Suspense>} />
    </Routes>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <DemoModeProvider>
        <SimulationModeProvider>
          <CameraControlsProvider>
            <AppRoutes />
          </CameraControlsProvider>
        </SimulationModeProvider>
      </DemoModeProvider>
    </ThemeProvider>
  );
}
