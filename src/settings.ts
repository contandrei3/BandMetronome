import type { SoundKind } from './audio/sounds';
import type { Subdivision } from './timeline';

export interface Settings {
  name: string;
  sound: SoundKind;
  volume: number;
  subdivision: Subdivision;
  /** Bluetooth/output latency compensation for this phone + headphones, in ms. */
  latencyMs: number;
}

const KEY = 'bandmetro.settings.v1';

const DEFAULTS: Settings = { name: '', sound: 'click', volume: 0.8, subdivision: 1, latencyMs: 0 };

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
