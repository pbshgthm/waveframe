// phase001 — tempo
//
// How fast is this footage moving? Nothing here looks at pixels; it reads the
// audio track and answers with a pulse.
//
//   decode at 11 kHz mono  ->  spectral flux  ->  autocorrelation  ->  period
//
// A caution learned from the footage this piece ships with. There is rarely one
// true tempo. Die With A Smile autocorrelates strongest at 52.7 (its 6/8
// dotted-quarter pulse) and also, more weakly, at 78.3 (the 4/4 half-time
// count) — a 3:2 relation, so no prior can separate them and neither is wrong.
// So this file does not pretend to find THE tempo. It finds a pulse, and `fit`
// then picks how many bars to hang a cycle on so the reunion lands near where
// the piece wants it. An octave out in the pulse just moves which bar count
// wins, and the piece still breathes at the right rate.

export const TEMPO = {
  rate:   11025,  // Hz to decode at — plenty for onsets, and 1/4 the memory
  win:    1024,   // FFT size: 93 ms, 10.8 Hz bins
  hop:    256,    // -> 43.07 analysis frames a second
  probe:  90,     // seconds of audio to read, taken from the middle
  lo:     50,     // slowest pulse to consider, BPM
  hi:     200,    // fastest
  prior:  100,    // BPM the search leans toward, log-normal
  spread: 1.0,    // how wide that lean is, in octaves
  target: 49,     // seconds between reunions the fit aims for
  bars:   [12, 16, 20, 24, 32, 40, 48, 64],
};

// ---- fft ------------------------------------------------------------------
// Iterative radix-2, in place. A 1024-point transform per frame; the naive
// O(n^2) sum would be ~100x slower and this runs on a 90 s window.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {           // bit-reversal permutation
    let b = n >> 1;
    for (; j & b; b >>= 1) j ^= b;
    j ^= b;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t;
                 t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k],        ui = im[i + k];
        const vr = re[i + k + len/2] * cr - im[i + k + len/2] * ci;
        const vi = re[i + k + len/2] * ci + im[i + k + len/2] * cr;
        re[i + k] = ur + vr;         im[i + k] = ui + vi;
        re[i + k + len/2] = ur - vr; im[i + k + len/2] = ui - vi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

// ---- onset envelope -------------------------------------------------------
// Spectral flux: how much energy APPEARED since the last frame. Only rises
// count — a note ending is not an onset. Magnitudes go through log1p first, so
// a quiet hi-hat counts for something next to a loud chord.
export function envelope(ch, rate) {
  const { win, hop, probe } = TEMPO;
  const want = Math.round(probe * rate);
  const off  = ch.length > want ? ((ch.length - want) >> 1) : 0;   // middle slice
  const len  = Math.min(ch.length - off, want);
  const frames = 1 + Math.floor((len - win) / hop);
  if (frames < 64) return null;

  const hann = new Float64Array(win);
  for (let k = 0; k < win; k++) hann[k] = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / win);

  const bins = win / 2 + 1;
  const re = new Float64Array(win), im = new Float64Array(win);
  let prev = new Float64Array(bins), cur = new Float64Array(bins);
  const flux = new Float64Array(frames);

  for (let t = 0; t < frames; t++) {
    const s = off + t * hop;
    for (let k = 0; k < win; k++) { re[k] = ch[s + k] * hann[k]; im[k] = 0; }
    fft(re, im);
    let f = 0;
    for (let k = 0; k < bins; k++) {
      cur[k] = Math.log1p(1000 * Math.hypot(re[k], im[k]) / win);
      if (t) { const d = cur[k] - prev[k]; if (d > 0) f += d; }
    }
    flux[t] = f;
    const swap = prev; prev = cur; cur = swap;
  }

  // Take off the slow drift so a loud chorus does not outvote a quiet verse,
  // then rectify: what is left is where the music pushed above its own recent
  // average, which is what a beat is.
  const fps = rate / hop;
  const k = Math.max(1, Math.round(0.4 * fps));
  const env = new Float64Array(frames);
  const run = new Float64Array(frames + 1);            // prefix sums: O(n), not O(nk)
  for (let t = 0; t < frames; t++) run[t + 1] = run[t] + flux[t];
  for (let t = 0; t < frames; t++) {
    const a = Math.max(0, t - k), b = Math.min(frames - 1, t + k);
    env[t] = Math.max(0, flux[t] - (run[b + 1] - run[a]) / (b - a + 1));
  }
  let m = 0; for (let t = 0; t < frames; t++) m += env[t] * env[t];
  const sd = Math.sqrt(m / frames) || 1;
  for (let t = 0; t < frames; t++) env[t] /= sd;
  return { env, fps };
}

// ---- pulse ----------------------------------------------------------------
export function pulse(ch, rate) {
  const e = envelope(ch, rate);
  if (!e) return null;
  const { env, fps } = e, N = env.length;
  const loL = Math.max(2, Math.floor(fps * 60 / TEMPO.hi));
  const hiL = Math.min(Math.floor(fps * 60 / TEMPO.lo), Math.floor(N / 3));
  if (hiL <= loL + 2) return null;

  const ac = new Float64Array(hiL + 2), sc = new Float64Array(hiL + 2);
  for (let L = loL; L <= hiL; L++) {
    let r = 0;
    for (let t = 0; t + L < N; t++) r += env[t] * env[t + L];
    ac[L] = r / (N - L);
    const oct = Math.log2((fps * 60 / L) / TEMPO.prior) / TEMPO.spread;
    sc[L] = ac[L] * Math.exp(-0.5 * oct * oct);
  }
  let p = loL;
  for (let L = loL; L <= hiL; L++) if (sc[L] > sc[p]) p = L;
  // parabolic refine: the true period rarely lands on a whole frame
  const a = sc[p - 1] || 0, b = sc[p], c = sc[p + 1] || 0, den = a - 2 * b + c;
  const d = den !== 0 ? 0.5 * (a - c) / den : 0;

  let mean = 0, n = 0;
  for (let L = loL; L <= hiL; L++) { mean += ac[L]; n++; }
  mean /= n || 1;
  return {
    bpm: fps * 60 / (p + Math.max(-0.5, Math.min(0.5, d))),
    salience: ac[p] / (mean || 1),          // how far the peak stands out, ~1 = nothing
    frames: N,
  };
}

// ---- decode ---------------------------------------------------------------
// Decoding through an OfflineAudioContext at 11 kHz makes the browser resample
// on the way out, so a four-minute track costs ~11 MB of samples instead of
// ~170 MB. The compressed bytes are the only large allocation, and they are
// dropped as soon as the decode returns.
export async function analyse(file) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) return { ok: false, why: 'no OfflineAudioContext' };
  let buf;
  try { buf = file instanceof ArrayBuffer ? file : await file.arrayBuffer(); }
  catch (err) { return { ok: false, why: 'unreadable: ' + err.message }; }

  let audio;
  try {
    const actx = new OAC(1, TEMPO.rate, TEMPO.rate);
    audio = await actx.decodeAudioData(buf);
  } catch (err) {
    return { ok: false, why: 'no decodable audio track (' + (err.message || err.name) + ')' };
  }
  if (!audio.length) return { ok: false, why: 'empty audio track' };

  let ch = audio.getChannelData(0);
  if (audio.numberOfChannels > 1) {                     // mix to mono
    const mix = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const s = audio.getChannelData(c);
      for (let i = 0; i < mix.length; i++) mix[i] += s[i] / audio.numberOfChannels;
    }
    ch = mix;
  }
  const r = pulse(ch, audio.sampleRate);
  return r ? { ok: true, ...r, seconds: audio.duration }
           : { ok: false, why: 'audio too short to read a pulse' };
}

// ---- from a pulse to a cycle ----------------------------------------------
// The piece is timed in bars, not seconds: a cycle is `bars` long and the top
// strip swings `perBar` times per bar, so every strip's rate is a whole
// multiple of the bar and the reunion lands on a barline. The half-cycle is a
// reunion too — at t = C/2 every displacement is sin(PI * whole) = 0 — so what
// a viewer actually waits is half a cycle, and that is what gets fitted.
// No audio at all, or nothing in it that reads as a pulse: hang the cycle on
// the clip's own length instead, so the picture still comes together a few
// times while it plays. Silent footage gets to be part of this too.
export function fromDuration(dur) {
  const times = Math.max(1, Math.round(dur / TEMPO.target));
  const reunion = dur / (times + 0.5);       // never land the last one on the cut
  return { bars: 0, base: 32, cycle: reunion * 2, reunion,
           beat: reunion / 16, fitted: false };
}

export function fit(bpm, beats, perBar, dur) {
  const beat = 60 / bpm;
  let best = null;
  for (const bars of TEMPO.bars) {
    const base = Math.round(bars * perBar);
    if (base < 4) continue;
    const cycle = bars * beats * beat;
    const reunion = cycle / 2;
    // do not ask for a reunion the clip is too short to ever show
    if (dur > 0 && reunion > dur * 0.75) continue;
    const err = Math.abs(Math.log(reunion / TEMPO.target));
    if (!best || err < best.err) best = { bars, base, cycle, reunion, err };
  }
  if (!best) return fromDuration(dur > 0 ? dur : TEMPO.target * 2);
  return { ...best, beat, fitted: true };
}
