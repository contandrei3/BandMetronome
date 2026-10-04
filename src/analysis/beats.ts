/**
 * Beat tracking for backing tracks, so the click can be lined up with a real
 * recording (whose tempo is rarely a round number, and often not constant).
 *
 * Method (after D. Ellis, "Beat Tracking by Dynamic Programming", 2007):
 *  1. onset strength: positive spectral flux of a log-magnitude spectrogram,
 *     high-passed and normalised;
 *  2. global tempo: autocorrelation of the onset envelope, weighted towards a
 *     preferred tempo (the song's BPM if known);
 *  3. beats: dynamic programming that picks onsets spaced close to that period,
 *     so it follows tempo drift but ignores off-beat hits.
 */

export const ANALYSIS_RATE = 11025;
const WIN = 512;
const HOP = 64;
const FPS = ANALYSIS_RATE / HOP;

export interface BeatAnalysis {
  /** Beat times in ms from the start of the file. */
  beats: number[];
  /** Index in `beats` of the first beat that is beat 1 of a bar. */
  downbeat: number;
  /**
   * Beats placed by extending the tempo of a nearby confident section, because
   * the audio there had no clear beat (e.g. a guitar-only intro).
   */
  extrapolated: number;
  /** Best constant tempo through all beats (least squares). */
  bpm: number;
  /** Largest distance (ms) of a beat from that constant grid: small = steady tempo. */
  maxDeviationMs: number;
}

/**
 * Mono samples at ANALYSIS_RATE -> beats. `bpmHint` biases the tempo search
 * (e.g. the typed BPM); `beatsPerBar` is used to find where bars start.
 */
export function analyzeBeats(samples: Float32Array, bpmHint?: number, beatsPerBar = 4): BeatAnalysis | null {
  const env = onsetEnvelope(samples);
  if (env.length < FPS * 4) return null;
  const period = estimatePeriod(env, bpmHint);
  if (!period) return null;
  const frames = trimSilentEnds(env, trackBeats(env, period));
  if (frames.length < 8) return null;
  const strength = frames.map((f) => peakNear(env, f));
  const { beats, extrapolated } = repairWeakRegions(
    frames.map((f) => frameToMs(refinePeak(env, f))),
    strength,
  );
  const fit = fitGrid(beats);
  const downbeat = findDownbeat(samples, beats, beatsPerBar);
  return { beats, downbeat, extrapolated, bpm: 60000 / fit.period, maxDeviationMs: fit.maxDeviation };
}

/** Least-squares constant grid through beat times: time = offset + i * period. */
export function fitGrid(beats: number[]): { period: number; offset: number; maxDeviation: number } {
  const n = beats.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  beats.forEach((y, x) => {
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  });
  const period = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const offset = (sy - period * sx) / n;
  const maxDeviation = Math.max(...beats.map((y, x) => Math.abs(y - (offset + x * period))));
  return { period, offset, maxDeviation };
}

/**
 * Beat times with detection jitter removed but tempo drift kept: each beat is
 * placed on a straight line fitted to its neighbours (about one bar on each
 * side), ignoring neighbours that are clearly off. A single misplaced beat
 * then no longer drags the click, while a band speeding up is still followed.
 */
export function smoothBeats(beats: number[], half = 4): number[] {
  return beats.map((_, i) => {
    let xs: number[] = [];
    for (let j = Math.max(0, i - half); j <= Math.min(beats.length - 1, i + half); j++) xs.push(j);
    let line = { k: 0, c: beats[i] };
    for (let pass = 0; pass < 2; pass++) {
      const n = xs.length;
      if (n < 2) break;
      const mx = xs.reduce((a, x) => a + x, 0) / n;
      const my = xs.reduce((a, x) => a + beats[x], 0) / n;
      let sxx = 0;
      let sxy = 0;
      for (const x of xs) {
        sxx += (x - mx) ** 2;
        sxy += (x - mx) * (beats[x] - my);
      }
      const k = sxy / sxx;
      line = { k, c: my - k * mx };
      const res = xs.map((x) => Math.abs(beats[x] - (line.c + line.k * x)));
      const mad = [...res].sort((a, b) => a - b)[res.length >> 1] || 1;
      const kept = xs.filter((_, q) => res[q] <= 3 * mad);
      if (kept.length < 4 || kept.length === xs.length) break;
      xs = kept;
    }
    return line.c + line.k * i;
  });
}

/** Slowest and fastest tempo over stretches of `span` beats (the "95–99 BPM" shown to the user). */
export function tempoRange(beats: number[], span = 16): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i + span < beats.length; i += Math.max(1, span >> 1)) {
    const bpm = (60000 * span) / (beats[i + span] - beats[i]);
    min = Math.min(min, bpm);
    max = Math.max(max, bpm);
  }
  return { min, max };
}

// ---------- 1. Onset strength ----------

/**
 * Time of the attack that peaks the onset envelope at `frame`. The flux peaks
 * once the attack is well inside the (Hann-weighted) window, so the frame
 * start lags the attack; the constant was measured on synthetic hits
 * (spread ±1 ms) and is checked by the tests.
 */
const ONSET_DELAY_MS = 38.8;
function frameToMs(frame: number): number {
  return ((frame * HOP) / ANALYSIS_RATE) * 1000 + ONSET_DELAY_MS;
}

export function onsetEnvelope(x: Float32Array): Float32Array {
  const frames = Math.max(0, Math.floor((x.length - WIN) / HOP) + 1);
  const bins = WIN / 2;
  const hann = new Float32Array(WIN).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN));
  const re = new Float64Array(WIN);
  const im = new Float64Array(WIN);
  let prev = new Float32Array(bins);
  let cur = new Float32Array(bins);
  const env = new Float32Array(frames);
  for (let t = 0; t < frames; t++) {
    const o = t * HOP;
    for (let i = 0; i < WIN; i++) {
      re[i] = x[o + i] * hann[i];
      im[i] = 0;
    }
    fft(re, im);
    let flux = 0;
    for (let k = 1; k < bins; k++) {
      cur[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      if (t > 0) flux += Math.max(0, cur[k] - prev[k]);
    }
    env[t] = flux;
    [prev, cur] = [cur, prev];
  }
  // High-pass: remove the slowly varying loudness, keep the attacks.
  const half = Math.round(FPS * 0.25);
  const out = new Float32Array(frames);
  let sum = 0;
  let count = 0;
  for (let t = -half; t < frames; t++) {
    if (t + half < frames) {
      sum += env[t + half];
      count++;
    }
    if (t - half - 1 >= 0) {
      sum -= env[t - half - 1];
      count--;
    }
    if (t >= 0) out[t] = Math.max(0, env[t] - sum / count);
  }
  let sq = 0;
  for (const v of out) sq += v * v;
  const sd = Math.sqrt(sq / Math.max(1, frames)) || 1;
  for (let t = 0; t < frames; t++) out[t] /= sd;
  return out;
}

/** In-place iterative radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

// ---------- 2. Global tempo ----------

/** Beat period in frames. */
export function estimatePeriod(env: Float32Array, bpmHint?: number): number | null {
  const minLag = Math.floor((FPS * 60) / 220);
  const maxLag = Math.ceil((FPS * 60) / 50);
  const center = (FPS * 60) / (bpmHint && bpmHint > 0 ? bpmHint : 120);
  // A typed BPM is trusted to within a few percent; without one, prefer tempos near 120.
  const width = bpmHint ? 0.15 : 1.0;
  const score = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let r = 0;
    for (let t = lag; t < env.length; t++) r += env[t] * env[t - lag];
    const w = Math.exp(-0.5 * (Math.log2(lag / center) / width) ** 2);
    score[lag] = (r / (env.length - lag)) * w;
  }
  let best = -1;
  for (let lag = minLag + 1; lag <= maxLag; lag++) if (best < 0 || score[lag] > score[best]) best = lag;
  if (best < 0 || score[best] <= 0) return null;
  const [a, b, c] = [score[best - 1], score[best], score[best + 1]];
  const d = a - 2 * b + c;
  return best + (d < 0 ? (0.5 * (a - c)) / d : 0);
}

// ---------- 3. Beat tracking ----------

/** Dynamic-programming beat tracker; returns beat frame indices. */
export function trackBeats(env: Float32Array, period: number, tightness = 100): number[] {
  const n = env.length;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let best = 0;
    let arg = -1;
    for (let tau = t - hi; tau <= t - lo; tau++) {
      if (tau < 0) continue;
      const v = score[tau] - tightness * Math.log((t - tau) / period) ** 2;
      if (arg < 0 || v > best) {
        best = v;
        arg = tau;
      }
    }
    score[t] = env[t] + (arg >= 0 ? Math.max(0, best) : 0);
    back[t] = arg >= 0 && best > 0 ? arg : -1;
  }
  // Best final beat within the last period.
  let end = n - 1;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) if (score[t] > score[end]) end = t;
  const beats: number[] = [];
  for (let t = end; t >= 0; t = back[t]) beats.push(t);
  return beats.reverse();
}

/**
 * The tracker keeps its rhythm going through silence before and after the
 * music; drop those beats (no real attack near them).
 */
function trimSilentEnds(env: Float32Array, frames: number[]): number[] {
  const strength = frames.map((f) => Math.max(...env.subarray(Math.max(0, f - 3), f + 4)));
  const median = [...strength].sort((a, b) => a - b)[strength.length >> 1];
  let lo = 0;
  let hi = frames.length;
  while (lo < hi && strength[lo] < 0.25 * median) lo++;
  while (hi > lo && strength[hi - 1] < 0.25 * median) hi--;
  return frames.slice(lo, hi);
}

function peakNear(env: Float32Array, f: number): number {
  let m = 0;
  for (let t = Math.max(0, f - 3); t <= Math.min(env.length - 1, f + 3); t++) m = Math.max(m, env[t]);
  return m;
}

/**
 * Where the beat is not audible (a guitar-only intro, a breakdown) the tracker
 * latches onto whatever notes are there and wanders. Runs of at least 4 beats
 * whose attacks are clearly weaker than the song's typical beat are replaced
 * by the tempo of the confident beats next to them: extended backwards for an
 * intro, forwards for an outro, interpolated for a gap in the middle.
 */
export function repairWeakRegions(beats: number[], strength: number[]): { beats: number[]; extrapolated: number } {
  const n = beats.length;
  if (n < 16) return { beats, extrapolated: 0 };
  // Typical strength of a clear beat, and a per-beat strength smoothed over about a bar.
  const typical = [...strength].sort((a, b) => a - b)[Math.floor(n * 0.75)];
  const local = strength.map((_, i) => {
    const w = strength.slice(Math.max(0, i - 2), i + 3).sort((a, b) => a - b);
    return w[w.length >> 1];
  });
  const weak = local.map((v) => v < 0.4 * typical);
  // A band does not change tempo by more than a few % from one beat to the next:
  // such jumps are the tracker catching up after following the wrong notes.
  const iv = beats.slice(1).map((b, i) => b - beats[i]);
  iv.forEach((v, i) => {
    const w = iv.slice(Math.max(0, i - 4), i + 5).sort((a, b) => a - b);
    const med = w[w.length >> 1];
    if (Math.abs(v - med) / med > 0.08) weak[i] = weak[i + 1] = true;
  });
  // Short confident stretches between unreliable ones are not trusted either.
  for (let i = 0; i < n; i++) {
    if (weak[i]) continue;
    let j = i;
    while (j + 1 < n && !weak[j + 1]) j++;
    if (i > 0 && j < n - 1 && j - i + 1 <= 3) for (let k = i; k <= j; k++) weak[k] = true;
    i = j;
  }
  const out = [...beats];
  let extrapolated = 0;
  for (let i = 0; i < n; ) {
    if (!weak[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && weak[j + 1]) j++;
    const len = j - i + 1;
    if (len >= 4) {
      const before = range(Math.max(0, i - 16), i).filter((k) => !weak[k]);
      const after = range(j + 1, Math.min(n, j + 17)).filter((k) => !weak[k]);
      if (after.length >= 8 && before.length < 8) {
        // Intro: extend the tempo of what follows backwards.
        const f = lineFit(after, out);
        for (let k = i; k <= j; k++) out[k] = f.c + f.k * k;
        extrapolated += len;
      } else if (before.length >= 8 && after.length < 8) {
        // Outro: extend forwards.
        const f = lineFit(before, out);
        for (let k = i; k <= j; k++) out[k] = f.c + f.k * k;
        extrapolated += len;
      } else if (before.length >= 8 && after.length >= 8) {
        // Gap: blend the tempo on both sides.
        const a = lineFit(before, out);
        const b = lineFit(after, out);
        for (let k = i; k <= j; k++) {
          const w = (k - i + 1) / (len + 1);
          out[k] = (1 - w) * (a.c + a.k * k) + w * (b.c + b.k * k);
        }
        extrapolated += len;
      }
    }
    i = j + 1;
  }
  return { beats: out, extrapolated };
}

function range(a: number, b: number): number[] {
  return Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
}

function lineFit(idx: number[], ys: number[]): { k: number; c: number } {
  const n = idx.length;
  const mx = idx.reduce((s, x) => s + x, 0) / n;
  const my = idx.reduce((s, x) => s + ys[x], 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const x of idx) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (ys[x] - my);
  }
  const k = sxy / sxx;
  return { k, c: my - k * mx };
}

/** Sub-frame position of the onset peak near a tracked beat. */
function refinePeak(env: Float32Array, f: number): number {
  let p = f;
  for (let t = Math.max(1, f - 3); t <= Math.min(env.length - 2, f + 3); t++) if (env[t] > env[p]) p = t;
  if (p <= 0 || p >= env.length - 1) return p;
  const [a, b, c] = [env[p - 1], env[p], env[p + 1]];
  const d = a - 2 * b + c;
  return d < 0 ? p + (0.5 * (a - c)) / d : p;
}

// ---------- 4. Bar starts ----------

/**
 * Which beats are beat 1. In most songs chords change at the start of a bar
 * and the kick drum is strongest there, so for every beat we measure how much
 * the harmony changes across it (pitch-class profile of the beat before vs
 * the beat after) and the low-frequency attack on it. Summed over the song
 * per position in the bar, the position with the highest score is beat 1.
 * Returns the index of the first such beat.
 */
export function findDownbeat(x: Float32Array, beats: number[], beatsPerBar: number): number {
  if (beatsPerBar < 2 || beats.length < beatsPerBar * 2) return 0;
  const n = 2048;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const hann = new Float32Array(n).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  const binHz = ANALYSIS_RATE / n;

  /** Pitch-class energy and low-band energy of the audio between two times. */
  const profile = (fromMs: number, toMs: number) => {
    const chroma = new Float64Array(12);
    let low = 0;
    const a = Math.max(0, Math.round((fromMs / 1000) * ANALYSIS_RATE));
    const b = Math.min(x.length - n, Math.round((toMs / 1000) * ANALYSIS_RATE) - n);
    for (let o = a; o <= Math.max(a, b); o += n / 2) {
      for (let i = 0; i < n; i++) {
        re[i] = (x[o + i] ?? 0) * hann[i];
        im[i] = 0;
      }
      fft(re, im);
      for (let k = 2; k < n / 2; k++) {
        const f = k * binHz;
        const mag = Math.hypot(re[k], im[k]);
        if (f < 150) low += mag;
        if (f > 80 && f < 2000) chroma[((Math.round(12 * Math.log2(f / 440)) % 12) + 12) % 12] += mag;
      }
    }
    const norm = Math.hypot(...chroma) || 1;
    return { chroma: chroma.map((v) => v / norm), low };
  };

  const spans = beats.map((t, i) => profile(t, beats[i + 1] ?? t + (t - beats[i - 1])));
  const change = beats.map((_, i) =>
    i === 0 ? 0 : 1 - spans[i].chroma.reduce((s, v, k) => s + v * spans[i - 1].chroma[k], 0),
  );
  const low = spans.map((s, i) => s.low - (i > 0 ? spans[i - 1].low : s.low));
  const z = (xs: number[]) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) || 1;
    return xs.map((v) => (v - m) / sd);
  };
  const zc = z(change);
  const zl = z(low);
  const score = new Float64Array(beatsPerBar);
  const count = new Float64Array(beatsPerBar);
  for (let i = 1; i < beats.length; i++) {
    score[i % beatsPerBar] += 2 * zc[i] + zl[i];
    count[i % beatsPerBar]++;
  }
  let best = 0;
  for (let p = 1; p < beatsPerBar; p++) if (score[p] / count[p] > score[best] / count[best]) best = p;
  return best;
}

/** Mixes a decoded file down to mono at ANALYSIS_RATE (browser only). */
export async function decodeForAnalysis(data: ArrayBuffer): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, 1, ANALYSIS_RATE);
  const buf = await ctx.decodeAudioData(data.slice(0));
  const out = new Float32Array(buf.length);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / buf.numberOfChannels;
  }
  return out;
}
