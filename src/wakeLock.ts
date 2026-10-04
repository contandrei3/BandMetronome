import media from 'nosleep.js/src/media.js';

let lock: WakeLockSentinel | null = null;
let video: HTMLVideoElement | null = null;
let listening = false;

/** iPhone/iPad (iPadOS reports itself as a Mac with touch). */
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/**
 * Keeps the screen on for the whole session with the Wake Lock API, plus — on
 * iPhones and wherever the API is missing or refused — a muted, invisible,
 * looping video, the usual trick on iOS (where home-screen apps before iOS
 * 18.4 get a wake lock that reports success but does nothing).
 * Call from a tap: the video only starts from a user gesture.
 */
export function keepScreenOn(): void {
  if (!listening) {
    listening = true;
    // A wake lock is released and the video paused whenever the page is hidden.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void acquire();
    });
  }
  void acquire();
}

async function acquire(): Promise<void> {
  if (document.visibilityState !== 'visible') return;
  let native = false;
  if ('wakeLock' in navigator) {
    try {
      if (!lock || lock.released) lock = await navigator.wakeLock.request('screen');
      native = true;
    } catch {
      // Refused (battery saver, unsupported context): the video below takes over.
    }
  }
  if (!native || isIOS) await playKeepAwakeVideo();
}

async function playKeepAwakeVideo(): Promise<void> {
  if (!video) {
    video = document.createElement('video');
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.muted = true;
    video.loop = true;
    video.setAttribute('aria-hidden', 'true');
    video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:0;top:0';
    const add = (src: string, type: string) => {
      const s = document.createElement('source');
      s.src = src;
      s.type = type;
      video!.append(s);
    };
    add(media.webm, 'video/webm');
    add(media.mp4, 'video/mp4');
    document.body.append(video);
  }
  if (video.paused) await video.play().catch(() => undefined);
}
