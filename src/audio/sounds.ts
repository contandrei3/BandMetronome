import type { TickLevel } from '../timeline';

export type SoundKind = 'beep' | 'woodblock' | 'cowbell' | 'click';

export const SOUND_LABELS: Record<SoundKind, string> = {
  beep: 'Digital Beep',
  woodblock: 'Woodblock',
  cowbell: 'Cowbell',
  click: 'Classic Click',
};

const LEVEL_GAIN: Record<TickLevel, number> = { accent: 1, beat: 0.75, sub: 0.4 };

/** Pitch multiplier so beat 1 stands out even when the volume is low. */
const LEVEL_PITCH: Record<TickLevel, number> = { accent: 1.5, beat: 1, sub: 0.85 };

export function makeNoiseBuffer(ctx: BaseAudioContext, seconds = 0.5): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/**
 * Schedules one synthesized click at AudioContext time `when`. Returns the
 * source nodes so the caller can cancel clicks that have not started yet.
 */
export function scheduleClick(
  ctx: BaseAudioContext,
  dest: AudioNode,
  kind: SoundKind,
  level: TickLevel,
  when: number,
  noise: AudioBuffer,
): AudioScheduledSourceNode[] {
  const g = LEVEL_GAIN[level];
  const p = LEVEL_PITCH[level];
  switch (kind) {
    case 'beep':
      return [tone(ctx, dest, 'sine', 1000 * p, when, 0.06, 0.9 * g)];
    case 'woodblock':
      return [
        tone(ctx, dest, 'triangle', 1200 * p, when, 0.05, 1.0 * g, 0.8),
        noiseBurst(ctx, dest, noise, when, 0.012, 2500 * p, 'bandpass', 0.6 * g),
      ];
    case 'cowbell': {
      // TR-808 style: two detuned squares through a band-pass.
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2000 * p;
      bp.Q.value = 1.2;
      bp.connect(dest);
      return [
        tone(ctx, bp, 'square', 540 * p, when, 0.18, 0.5 * g),
        tone(ctx, bp, 'square', 800 * p, when, 0.18, 0.5 * g),
      ];
    }
    case 'click':
      return [noiseBurst(ctx, dest, noise, when, 0.02, 3000 * p, 'highpass', 1.2 * g)];
  }
}

function envelope(ctx: BaseAudioContext, dest: AudioNode, when: number, decay: number, peak: number): GainNode {
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(peak, when + 0.001);
  env.gain.exponentialRampToValueAtTime(0.0001, when + decay);
  env.connect(dest);
  return env;
}

function tone(
  ctx: BaseAudioContext,
  dest: AudioNode,
  type: OscillatorType,
  freq: number,
  when: number,
  decay: number,
  peak: number,
  pitchDrop = 1,
): OscillatorNode {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, when);
  if (pitchDrop !== 1) osc.frequency.exponentialRampToValueAtTime(freq * pitchDrop, when + decay);
  osc.connect(envelope(ctx, dest, when, decay, peak));
  osc.start(when);
  osc.stop(when + decay + 0.01);
  return osc;
}

function noiseBurst(
  ctx: BaseAudioContext,
  dest: AudioNode,
  noise: AudioBuffer,
  when: number,
  decay: number,
  freq: number,
  filterType: BiquadFilterType,
  peak: number,
): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const f = ctx.createBiquadFilter();
  f.type = filterType;
  f.frequency.value = freq;
  src.connect(f);
  f.connect(envelope(ctx, dest, when, decay, peak));
  // Random start inside the buffer so consecutive clicks are not identical.
  src.start(when, Math.random() * (noise.duration - decay - 0.02));
  src.stop(when + decay + 0.01);
  return src;
}
