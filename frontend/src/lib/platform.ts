/**
 * The one place that decides whether the person is on an Apple platform, so
 * every shortcut hint names the modifier their keyboard actually has: the
 * command key on macOS and iOS, Ctrl everywhere else.
 */

/** The parts of `navigator` the check reads, for a test to stand in for. */
interface PlatformSource {
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
}

/** Whether a navigator-like source reports an Apple platform. */
export const isApplePlatform = (
  source: PlatformSource | undefined = globalThis.navigator
): boolean => {
  if (source === undefined) return false;
  const reported =
    source.userAgentData?.platform ?? source.platform ?? source.userAgent ?? '';
  return /mac|iphone|ipad|ipod/i.test(reported);
};

/** The label for the primary modifier: the command symbol on Apple, else Ctrl. */
export const modKeyLabel = (apple: boolean = isApplePlatform()): string =>
  apple ? '⌘' : 'Ctrl';

/** The label for the Shift key: its symbol on Apple, else the word. */
export const shiftKeyLabel = (apple: boolean = isApplePlatform()): string =>
  apple ? '⇧' : 'Shift';

/** The hint for the modifier plus Enter submit, compact on Apple. */
export const submitKeysLabel = (apple: boolean = isApplePlatform()): string =>
  apple ? '⌘↵' : 'Ctrl ↵';
