/**
 * Browser entry point. Mounts the app inside the router, the auth provider and
 * an error boundary, so nothing a page throws can leave the screen empty, and
 * retires the static splash index.html painted in the same commit. A preload
 * that fails because a deploy pruned the chunk reloads the tab once, and a
 * tab left open across a deploy loads the new build at its next navigation.
 * The print stylesheet loads after the app's own, so a print is black on
 * white whatever the theme.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { BootSplashHandoff } from './components/layout/BootSplash';
import BuildFreshness from './components/routes/BuildFreshness';
import RouteErrorBoundary from './components/routes/RouteErrorBoundary';
import SsoReturnHandler from './components/auth/SsoReturnHandler';
import DesktopShellBridge from './components/desktop/DesktopShellBridge';
import MobileShellBridge from './components/mobile/MobileShellBridge';
import { AuthProvider } from './contexts/AuthContext';
import { reloadOnceForChunkError } from './lib/chunkReload';
import { installPrintExpansion } from './lib/print';
import './index.css';
import './styles/print.css';

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('Root element not found');
}

installPrintExpansion();

window.addEventListener('vite:preloadError', (event) => {
  if (reloadOnceForChunkError()) event.preventDefault();
});

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <BootSplashHandoff />
      <BuildFreshness />
      <RouteErrorBoundary>
        <AuthProvider>
          <DesktopShellBridge />
          <MobileShellBridge />
          <SsoReturnHandler />
          <App />
        </AuthProvider>
      </RouteErrorBoundary>
    </BrowserRouter>
  </StrictMode>
);
