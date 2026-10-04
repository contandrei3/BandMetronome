import type { SoundKind } from './audio/sounds';
import type { Role } from './roles';
import type { Subdivision } from './timeline';

export interface Settings {
  /** This device's member: chosen once on the role picker. */
  role: Role | null;
  sound: SoundKind;
  volume: number;
  /** All backing tracks together. */
  trackVolume: number;
  /** This member's volume per backing-track file id (overrides the song's default). */
  fileVolumes: Record<string, number>;
  subdivision: Subdivision;
  /** Bluetooth/output latency compensation for this phone + headphones, in ms. */
  latencyMs: number;
  /** Master only: free tempo or songs, and the last loaded song. */
  masterMode: 'free' | 'songs';
  lastSongId: string | null;
}

const KEY = 'bandmetro.settings.v1';

const DEFAULTS: Settings = { role: null, sound: 'click', volume: 0.8, trackVolume: 0.8, fileVolumes: {}, subdivision: 1, latencyMs: 0, masterMode: 'free', lastSongId: null };

export function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private mode or storage disabled: settings just won't persist.
  }
}
