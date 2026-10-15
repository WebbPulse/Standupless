/**
 * Browser entry point. Mounts the app inside the router and the auth provider,
 * and retires the static splash index.html painted in the same commit.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { BootSplashHandoff } from './components/layout/BootSplash';
import DesktopShellBridge from './components/desktop/DesktopShellBridge';
import MobileShellBridge from './components/mobile/MobileShellBridge';
import { AuthProvider } from './contexts/AuthContext';
import './index.css';

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <BootSplashHandoff />
      <AuthProvider>
        <DesktopShellBridge />
        <MobileShellBridge />
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);
