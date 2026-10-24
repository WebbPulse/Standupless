/**
 * Connects the page to the iOS or Android app when it runs inside one, and
 * renders nothing either way. It marks the document so the mobile stylesheet
 * can keep content clear of the notch and the home indicator, keeps the status
 * bar readable on the person's theme, hides the launch splash once the app has
 * painted, and routes deep links client side so the open page and its state
 * survive. A sign-in handoff link closes the browser tab, is redeemed against
 * the pending verifier and is never routed. In a browser it does nothing at
 * all.
 */

import { useEffect } from 'react';
import { useAuthClient } from '@webbpulse/auth/react';
import { useNavigate } from 'react-router-dom';
import { isMobileShell, mobileLinkPath } from '../../lib/mobile';
import {
  completeMobileBrowserSignIn,
  hasPendingMobileHandoff,
  isMobileHandoffLink,
} from '../../lib/mobileHandoff';
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

/** The handoff links already redeemed, so a link delivered twice runs once. */
const claimedHandoffLinks = new Set<string>();

/** Claims a handoff link for redeeming, false when it was claimed before. */
const claimHandoffLink = (url: string): boolean => {
  if (claimedHandoffLinks.has(url)) return false;
  claimedHandoffLinks.add(url);
  return true;
};

/** The mobile app's link to the page: marker, system bars, splash and links. */
const MobileShellBridge = (): null => {
  const navigate = useNavigate();
  const client = useAuthClient();

  useEffect(() => {
    if (!isMobileShell()) return;
    const root = document.documentElement;
    root.setAttribute('data-mobile-shell', '');
    coverViewport();
    let disposed = false;
    const cleanups: (() => void)[] = [];

    const finishHandoff = async (url: string): Promise<void> => {
      await import('@capacitor/browser')
        .then(({ Browser }) => Browser.close())
        .catch(() => undefined);
      const path = await completeMobileBrowserSignIn(url, client);
      void navigate(path, { replace: true });
    };

    const openLink = (url: string): void => {
      if (isMobileHandoffLink(url)) {
        if (claimHandoffLink(url)) void finishHandoff(url);
        return;
      }
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
      if (!disposed && launch?.url && isMobileHandoffLink(launch.url)) {
        if (hasPendingMobileHandoff()) openLink(launch.url);
      } else if (!disposed && launch?.url) {
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
  }, [navigate, client]);

  return null;
};

export default MobileShellBridge;
