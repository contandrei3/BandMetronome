/** Keeps the screen on for the whole session; the lock is lost whenever the page is hidden. */
export function keepScreenOn(): void {
  let lock: WakeLockSentinel | null = null;
  const acquire = async () => {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || (lock && !lock.released)) return;
    try {
      lock = await navigator.wakeLock.request('screen');
    } catch {
      // Battery saver or unsupported: nothing more we can do.
    }
  };
  document.addEventListener('visibilitychange', acquire);
  void acquire();
}
