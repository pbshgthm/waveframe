// phase001 — pendulum wave
//
// A row of N uncoupled pendulums. Nothing connects them. The only thing they
// share is a release: all let go from the centre at t = 0.
//
//   f_i = (base + i) / cycle        strip i makes (base + i) swings per cycle
//   x_i(t) = sin(2*PI * f_i * t)    its displacement, -1..1
//
// Every f_i is an integer multiple of 1/cycle, so at t = cycle every strip is
// back at zero at the same instant — the reunion. In between, the integers beat
// against each other: near t = cycle/2 the odd and even strips separate into
// two groups, near cycle/3 into three, and away from those simple fractions the
// row reads as a travelling wave. No wave is being propagated. It is N straight
// lines through a shared origin, seen edge on.
//
// Nothing here knows about pixels, images or canvases.

export const DEFAULTS = {
  strips:  18,    // how many slices the image is cut into
  base:    32,    // swings the first strip completes in one cycle
  step:    1,     // how many more swings each strip does than the one above it
  cycle:   98.08, // seconds from reunion to reunion (app.js derives this from tempo)
  ease:    0.85,  // <1 lingers at the turning points, >1 at the centre, 1 = sine
  amp:     0.11,  // peak displacement, as a fraction of the image width
  frame:   0.70,  // widest the picture may be, as a fraction of the viewport
  gap:     0.22,  // band of the picture left undrawn, as a fraction of each slot
  spindle: 0,     // how far a strip's waist swells past its two ends (0 = plain strips)
  ends:    0.20,  // fraction of a strip's length that dissolves at each end
  blur:    0,     // softness of the taper's edge, in CSS pixels (0 = hard)
  enter:   1,     // beats between one strip arriving and the next
  fade:    0.75,  // how far a strip dissolves at its furthest excursion
  reach:   1.45,  // fade completes this many excursions out, not exactly one
  sides:   0.10,  // fraction of the picture's width that fades at each side
  bloom:   1,     // colour drained at the turning point, 1 = fully grey there
  gain:    0.30,  // brightness gained at the centre, on top of the picture's own
  lift:    0.55,  // brightness lost at the turning point
  curve:   2,     // how wide colour holds around the centre; >1 = wider
  vert:    1,     // 1 = stripes stand side by side and slide up and down
  wrap:    0,     // 1 = strips wrap around the frame instead of sliding off it
  seams:   0,     // 1 = mark each cut with a hairline so the slicing is legible
  speed:   1,     // time multiplier
  trail:   0,     // afterimage
};
export class Wave {
  constructor(params) { this.set(params); }

  set(p) {
    this.p = { ...DEFAULTS, ...p };
    const n = this.n = Math.max(2, this.p.strips | 0);
    this.f = new Float64Array(n);   // swings per second
    this.x = new Float64Array(n);   // displacement, refilled every frame
    for (let i = 0; i < n; i++) {
      this.f[i] = (this.p.base + i * this.p.step) / this.p.cycle;
    }
  }

  // A sine already moves fastest at the centre and stops dead at the ends.
  // This bends how long it lingers there without touching where it is: raising
  // |sin| to a power leaves every zero a zero, so ease is free to be anything
  // and the reunion stays exact.
  _ease(s) {
    const e = this.p.ease;
    return e === 1 ? s : Math.sign(s) * Math.pow(Math.abs(s), e);
  }

  // Displacements at time t. Writes into the reused buffer and returns it.
  at(t) {
    const n = this.n, f = this.f, x = this.x, TAU = Math.PI * 2;
    for (let i = 0; i < n; i++) x[i] = this._ease(Math.sin(TAU * f[i] * t));
    return x;
  }

  // How much of one piece the row is right now, 0..1.
  // This is the Kuramoto order parameter: treat each strip's phase as a unit
  // vector and average them. All pointing the same way -> 1 (the image is
  // whole). Spread evenly around the circle -> 0 (fully scattered).
  coherence(t) {
    const n = this.n, f = this.f, TAU = Math.PI * 2;
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i++) {
      const th = TAU * f[i] * t;
      sx += Math.cos(th); sy += Math.sin(th);
    }
    return Math.hypot(sx, sy) / n;
  }

  // Seconds until the whole row is back together.
  toReunion(t) {
    const c = this.p.cycle;
    return c - ((t % c) + c) % c;
  }

  // The row splits into k visible groups near t = cycle * (j/k). Report which
  // simple fraction of the cycle we are closest to, for the readout.
  grouping(t) {
    const c = this.p.cycle;
    const u = ((t % c) + c) % c / c;           // 0..1 through the cycle
    let best = null, bestErr = 1;
    for (let k = 1; k <= 8; k++) {
      for (let j = 1; j < k; j++) {
        if (gcd(j, k) !== 1) continue;
        const err = Math.abs(u - j / k);
        if (err < bestErr) { bestErr = err; best = k; }
      }
    }
    return bestErr < 0.012 ? best : 0;          // 0 = no clean grouping
  }
}

function gcd(a, b) { while (b) { const t = a % b; a = b; b = t; } return a; }
