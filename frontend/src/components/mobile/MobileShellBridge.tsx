/**
 * Connects the page to the iOS or Android app when it runs inside one, and
 * renders nothing either way. It marks the document so the mobile stylesheet
 * can keep content clear of the notch and the home indicator, keeps the status
 * bar readable on the person's theme, hides the launch splash once the app has
 * painted, and routes deep links client side so the open page and its state
 * survive. In a browser it does nothing at all.
 */

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { isMobileShell, mobileLinkPath } from '../../lib/mobile';
import { isDarkNow, readTheme, subscribeTheme } from '../../lib/theme';
import './mobile.css';

/** The viewport the app needs so the page can paint under the system bars. */
const COVER_VIEWPORT = 'viewport-fit=cover';

/**
 * Adds `viewport-fit=cover` to the viewport meta in the app only, so Safari
 * and every other browser keep the layout they have today.
 */
const coverViewport = (): void => {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (meta === null || meta.content.includes('viewport-fit')) return;
  meta.content = `${meta.content}, ${COVER_VIEWPORT}`;
};

/** The mobile app's link to the page: marker, system bars, splash and links. */
const MobileShellBridge = (): null => {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isMobileShell()) return;
    const root = document.documentElement;
    root.setAttribute('data-mobile-shell', '');
    coverViewport();
    let disposed = false;
    const cleanups: (() => void)[] = [];

    const openLink = (url: string): void => {
      const path = mobileLinkPath(url);
      if (path !== null) void navigate(path);
    };

    void (async () => {
      const [{ SystemBars, SystemBarsStyle }, { App }, { SplashScreen }] =
        await Promise.all([
          import('@capacitor/core'),
          import('@capacitor/app'),
          import('@capacitor/splash-screen'),
        ]);
      if (disposed) return;

      const syncBars = (): void => {
        void SystemBars.setStyle({
          style: isDarkNow(readTheme())
            ? SystemBarsStyle.Dark
            : SystemBarsStyle.Light,
        }).catch(() => undefined);
      };
      syncBars();
      cleanups.push(subscribeTheme(syncBars));
      const scheme = globalThis.matchMedia('(prefers-color-scheme: dark)');
      scheme.addEventListener('change', syncBars);
      cleanups.push(() => {
        scheme.removeEventListener('change', syncBars);
      });

      const handle = await App.addListener('appUrlOpen', (event) => {
        openLink(event.url);
      });
      if (disposed) {
        void handle.remove();
      } else {
        cleanups.push(() => {
          void handle.remove();
        });
      }

      const launch = await App.getLaunchUrl().catch(() => undefined);
      if (!disposed && launch?.url) {
        const path = mobileLinkPath(launch.url);
        const here = `${globalThis.location.pathname}${globalThis.location.search}${globalThis.location.hash}`;
        if (path !== null && path !== here) void navigate(path);
      }

      await SplashScreen.hide().catch(() => undefined);
    })();

    return () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      root.removeAttribute('data-mobile-shell');
    };
  }, [navigate]);

  return null;
};

export default MobileShellBridge;
