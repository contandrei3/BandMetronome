/** Short commit hash (or "dev") injected at build time, shown on the start screen. */
declare const __BUILD__: string;

/** Tiny silent videos shipped with nosleep.js (data URIs), used to keep iPhone screens on. */
declare module 'nosleep.js/src/media.js' {
  const media: { webm: string; mp4: string };
  export default media;
}
