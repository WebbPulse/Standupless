/**
 * Connects the page to the desktop app when it runs inside one, and renders
 * nothing either way. It marks the document so the desktop stylesheet can
 * leave room for the macOS traffic lights, keeps the native window chrome on
 * the person's theme, and routes deep links client side so the open page and
 * its state survive. In a browser it does nothing at all.
 */

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { desktopBridge } from '../../lib/desktop';
import { readTheme, subscribeTheme } from '../../lib/theme';
import './desktop.css';

/** The desktop shell's link to the page: document marker, theme and routing. */
const DesktopShellBridge = (): null => {
  const navigate = useNavigate();

  useEffect(() => {
    const bridge = desktopBridge();
    if (bridge === null) return;
    const root = document.documentElement;
    root.setAttribute('data-desktop-shell', bridge.platform);
    const syncTheme = (): void => {
      bridge.setTheme(readTheme());
    };
    syncTheme();
    const unsubscribeTheme = subscribeTheme(syncTheme);
    const unsubscribeNavigate = bridge.onNavigate((path) => {
      if (path.startsWith('/') && !path.startsWith('//')) {
        void navigate(path);
      }
    });
    return () => {
      unsubscribeTheme();
      unsubscribeNavigate();
      root.removeAttribute('data-desktop-shell');
    };
  }, [navigate]);

  return null;
};

export default DesktopShellBridge;
