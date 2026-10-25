/**
 * A short tap of haptic feedback for a touch gesture that lands, such as a
 * long press opening a row's menu. Inside the iOS and Android apps it goes
 * through the native Haptics plugin when the shell carries one; elsewhere it
 * falls back to the vibration API, which most phones' browsers honour and
 * the rest ignore. Capacitor loads only on first use, like the Browser plugin
 * in `lib/shell`, because the public pages prerender outside a browser.
 */

/** The native plugin's one call this module makes. */
interface HapticsPlugin {
  impact: (options: { style: 'LIGHT' | 'MEDIUM' | 'HEAVY' }) => Promise<void>;
}

/** The parts of the Capacitor global the apps inject that this module reads. */
interface CapacitorGlobal {
  isPluginAvailable?: (name: string) => boolean;
}

let hapticsPlugin: Promise<HapticsPlugin> | null = null;

/** Registers the native Haptics plugin once, on first use. */
const nativeHaptics = (): Promise<HapticsPlugin> => {
  hapticsPlugin ??= import('@capacitor/core').then(({ registerPlugin }) =>
    registerPlugin<HapticsPlugin>('Haptics')
  );
  return hapticsPlugin;
};

/** Whether the app shell around the page carries the native Haptics plugin. */
const hasNativeHaptics = (): boolean => {
  const capacitor = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
  try {
    return capacitor?.isPluginAvailable?.('Haptics') === true;
  } catch {
    return false;
  }
};

/** The length of the fallback vibration, in milliseconds. */
const VIBRATE_MS = 10;

/** Plays one short haptic tap where the device offers one, and does nothing otherwise. */
export const buzz = (): void => {
  if (hasNativeHaptics()) {
    void nativeHaptics()
      .then((plugin) => plugin.impact({ style: 'MEDIUM' }))
      .catch(() => undefined);
    return;
  }
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try {
      navigator.vibrate(VIBRATE_MS);
    } catch {
      return;
    }
  }
};
