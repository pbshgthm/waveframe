import './style.css';
import { DEFAULTS, Wave } from './wave.js';
import { analyse, fit as fitTempo, fromDuration, TEMPO } from './tempo.js';

// phase001 — renderer
//
// wave.js says where each strip is. This file cuts the picture into those
// strips and slides them. Nothing else moves: the footage plays forward at its
// own rate, and the only transform applied to it is an offset per strip.
//
// There are no controls. Every number is fixed at its value in wave.js, and the
// only thing a viewer can do is start it and stop it.
const cv    = document.getElementById('c');
const ctx   = cv.getContext('2d', { alpha: false });
const vid   = document.getElementById('v');
const start = document.getElementById('start');   // full-viewport, first click only
const tog   = document.getElementById('tog');     // corner, every click after
const togI  = document.getElementById('tog-i');

// The bundled footage ships with its pulse DECLARED rather than detected, and
// that is deliberate. Run tempo.js on this same file and it answers 52.7 — the
// song's 6/8 dotted-quarter pulse, which autocorrelates twice as strongly as
// the 78.3 four-four half-time count the piece was tuned by eye against. Both
// are really in there (78.3 sits at 0.458 of the winning peak, and 52.7 x 1.5 =
// 79), and neither is the wrong answer. So the shipped clip keeps the reading
// it was composed to; a `bpm` here is taken at its word. Anything dropped on
// the page has no such answer to hand, and gets listened to.
// The 4K master is 344 MiB, past GitHub's 100 MB-per-file limit, so it is not
// bundled: it lives in Cloudflare R2 and is streamed from storage.poobesh.com.
// The canvas takes it cross-origin, which taints the canvas — and costs
// nothing, because drawImage is happy either way and nothing here ever reads a
// pixel back. No crossorigin attribute, so no CORS policy is needed on the
// bucket; the tempo read only ever runs on files dropped from the desktop.
const SOURCE = { src: 'https://storage.poobesh.com/diewithasmile.mp4', bpm: 78.30, beats: 4 };
const MIN_PULSE = 1.35;     // how far a peak must stand out to be believed

// The wave is timed in bars, not seconds: a cycle is `bars` long and the top
// strip swings `perBar` times per bar, so every strip's rate is a clean
// multiple of the bar and the reunion lands on a barline. bars is a multiple of
// four and perBar of a quarter, so base comes out a whole number — which is
// what makes the reunion exact rather than merely close.
const MUSIC = { bars: 32, perBar: 1 };

const P = Object.assign({}, DEFAULTS);
P.cycle = MUSIC.bars * (SOURCE.beats * 60 / SOURCE.bpm);
P.base  = Math.max(1, Math.round(MUSIC.bars * MUSIC.perBar));
const wave = new Wave(P);

// Re-derived every time the footage changes, so these are not constants.
let BEAT = 60 / SOURCE.bpm;                  // 0.766 s for the bundled clip
let STAG = Math.max(0.05, P.enter) * BEAT;   // one strip arrives every STAG
let DUR  = 0;                                // the clip's length, once known

// Hang the wave on a fit: how long a cycle runs, and how many swings the top
// strip makes inside it.
function apply(f) {
  P.cycle = f.cycle;
  P.base  = f.base;
  wave.set(P);
  BEAT = f.beat;
  // Eighteen strips at one a beat is fourteen seconds in and fourteen out. On a
  // short clip that is the entire thing — every strip enters its exit window
  // before the picture has assembled, and nothing is ever drawn. So the ramp is
  // capped at a third of the running time, and short footage still gets a
  // gathering and a leaving, just faster ones.
  STAG = Math.min(Math.max(0.05, P.enter) * BEAT,
                  DUR > 0 ? DUR / (wave.n * 3) : Infinity);
}

// Listen to whatever was just dropped, then step onto its pulse. The wave keeps
// swinging on the old one throughout — decoding a long track takes a second or
// two — and changes rate when the answer arrives, at whatever phase it is in.
async function listen(file) {
  apply(fromDuration(DUR || TEMPO.target * 2));     // something sane meanwhile
  const r = await analyse(file);
  const ok = r.ok && r.salience >= MIN_PULSE;
  apply(ok ? fitTempo(r.bpm, SOURCE.beats, MUSIC.perBar, DUR) : fromDuration(DUR));
  return ok ? r : { ...r, ok: false };
}

// What is being cut right now: the <video>, or an <img> dropped on the page.
let media = { kind: 'video', el: vid };

let W = 0, H = 0, DPR = 1;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = Math.max(1, Math.round(cv.clientWidth * DPR));
  H = Math.max(1, Math.round(cv.clientHeight * DPR));
  cv.width = W; cv.height = H;
  ctx.fillStyle = '#040405';
  ctx.fillRect(0, 0, W, H);
}
window.addEventListener('resize', resize);

const mediaSize = () => media.kind === 'video'
  ? [media.el.videoWidth, media.el.videoHeight]
  : [media.el.naturalWidth, media.el.naturalHeight];
const mediaReady = () => media.kind === 'video'
  ? media.el.readyState >= 2 : media.el.complete;

// Where a single strip is assembled before it is stamped onto the page. Going
// through a buffer is what lets the end fade be a fade at all: a clip path is
// binary — a pixel is in or out — but a mask multiplied in can be any value in
// between. It is also what keeps the edges clean, since nothing is ever painted
// over the image and then partly erased.
const sb = document.createElement('canvas');
const sx = sb.getContext('2d');

// ---- clock ---------------------------------------------------------------
// The wave keeps its own time, so a dropped still image still swings.
let t = 0, playing = false, last = performance.now();

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (playing) t += dt * P.speed;
  draw();
  requestAnimationFrame(frame);
}

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

// ---- the cut -------------------------------------------------------------
function draw() {
  ctx.fillStyle = 'rgba(4,4,5,' + (1 - Math.max(0, Math.min(0.85, P.trail))).toFixed(3) + ')';
  ctx.fillRect(0, 0, W, H);

  if (!mediaReady()) return;
  const [sw, sh] = mediaSize();
  if (!sw || !sh) return;

  // The picture deliberately does not fill the viewport. It sits centred, and
  // `frame` caps it along whichever axis the strips travel on — that margin is
  // the empty space where a strip leaving the picture becomes readable as
  // motion. The other axis just gets a small breathing margin.
  const vert = !!P.vert;
  const s = vert ? Math.min(W * 0.92 / sw, H * P.frame / sh)
                 : Math.min(W * P.frame / sw, H * 0.88 / sh);
  const fw = sw * s, fh = sh * s;
  const fx = (W - fw) / 2, fy = (H - fh) / 2;

  const n = wave.n;
  const x = wave.at(t);

  // A gap is not space pushed between strips — it is a band of the picture that
  // is never drawn. The source skips it as well, so the assembled picture keeps
  // the exact rectangle and proportions it would have had with no gaps at all:
  // at the reunion you read the original image with slots punched out of it,
  // not an image cut up and spread apart.
  const g = Math.max(0, Math.min(0.6, P.gap));

  // The same wave turned ninety degrees. Horizontal: strips stacked up the
  // picture, sliding left and right. Vertical: stripes standing side by side,
  // sliding up and down. Only the mapping changes; the maths is untouched.
  const A     = P.amp * (vert ? fh : fw);   // furthest a strip travels
  const slot  = (vert ? fw : fh) / n;       // one strip plus the band it drops
  const sSlot = (vert ? sw : sh) / n;
  const sLen  = sSlot * (1 - g);
  // with no gap, overlap by a hair so no seam line shows between strips
  const dLen  = slot * (1 - g) + (g > 0 ? 0 : 0.7);
  const len   = vert ? fh : fw;             // a strip's length, along its travel
  const src   = media.el;
  const BG    = 'rgba(4,4,5,';

  // A strip is a plain rectangle that dissolves into the background before it
  // reaches either of its ends. That dissolve is silhouette only — the image is
  // drawn undistorted and then multiplied by a mask, so the reunion still reads
  // as the original photograph.
  //
  // `spindle` can narrow the rectangle toward those ends as well; at 0 it does
  // not, and e falls to 0, which collapses all four Beziers below onto the
  // rectangle's own straight sides. When it is turned up the taper is an exact
  // smoothstep rather than the obvious parabola: v^2 is flat at the waist but
  // steepest exactly where it runs into the flat end cap, so the silhouette
  // arrives on a visible corner, where 3t^2 - 2t^3 is level at both. It is not
  // approximated but reproduced — space the control points' y evenly (which
  // makes y linear in t) and put P1 on P0's x and P2 on P3's x, and the curve
  // the rasteriser draws *is* x0 + e*(1 - 3t^2 + 2t^3).
  const sp = Math.max(0, Math.min(0.6, P.spindle));
  const ef = Math.max(0, Math.min(0.9, P.ends));
  const e  = dLen * sp / 2;        // how far the waist swells past the ends
  const q  = ef / 2;               // where the end dissolve finishes, 0..1 of len
  const bl = Math.max(0, P.blur) * DPR;
  const pad = Math.ceil(bl * 3 + 2);
  fit(sb, Math.ceil((vert ? dLen : fw) + 2 * pad + 2),
          Math.ceil((vert ? fh : dLen) + 2 * pad + 2));

  // ---- who is on stage --------------------------------------------------
  // The row does not arrive all at once. One strip turns up every STAG, in
  // order, until all eighteen are here; at the far end of the song they leave
  // in the same order they came. Only their opacity is staggered — every strip
  // has been swinging on the shared clock the whole time, because a strip that
  // started its own clock late would never come home with the others.
  const dur = media.kind === 'video' && isFinite(vid.duration) ? vid.duration : 0;
  const vt  = media.kind === 'video' ? vid.currentTime : t;
  const outAt = dur - n * STAG;             // when the first strip starts leaving

  // ---- colour from position ---------------------------------------------
  // A strip is fully coloured passing through the centre of its travel and
  // drains toward grey at the turn. Nothing here knows about groups, and it
  // does not need to: strips sharing a phase share a displacement, so they
  // share a colour, and each grouping paints itself in as many tones as it has
  // groups. Driving this off displacement rather than index is also what makes
  // it safe at the reunion — every displacement is zero at once, so the whole
  // picture arrives at full colour on the same frame.
  //
  // |x| is raised to `curve` before it is used. Straight |x| would put full
  // colour at a single instant, and with ease < 1 a strip spends most of its
  // time out at the turn, so the colour would read as a flicker rather than as
  // the state the picture returns to.
  //
  // Brightness rides the same curve, but it swings THROUGH 1 rather than down
  // from it. Darkening the turn alone barely registers: the footage is dark to
  // begin with and the travel fade is already dimming those same strips, so the
  // eye has nothing bright to measure the loss against. Lifting the centre past
  // 1 gives it one, and it puts the brightest instant of the whole piece exactly
  // where every strip is centred at once — the reunion.
  const tone = i => {
    const u = Math.pow(Math.abs(x[i]), P.curve);   // 0 at the centre, 1 at the turn
    const sa = 1 - P.bloom * u;
    const br = (1 + P.gain) - (P.gain + P.lift) * u;
    return (sa > 0.995 && Math.abs(br - 1) < 0.005)
      ? 'none'
      : 'saturate(' + sa.toFixed(3) + ') brightness(' + br.toFixed(3) + ')';
  };

  const strip = (i, off, alpha, filt) => {
    const dx = vert ? fx + i * slot : fx + off;
    const dy = vert ? fy + off      : fy + i * slot;

    // Stamp on whole pixels and carry the fraction inside the buffer instead,
    // so the final drawImage never resamples the strip it just assembled.
    const ix = Math.floor(dx) - pad, iy = Math.floor(dy) - pad;
    const PX = dx - ix, PY = dy - iy;

    sx.clearRect(0, 0, sb.width, sb.height);
    sx.filter = filt;
    if (vert) sx.drawImage(src, i * sSlot, 0, sLen, sh, PX, PY, dLen, fh);
    else      sx.drawImage(src, 0, i * sSlot, sw, sLen, PX, PY, fw, dLen);

    // One operation for both parts of the silhouette. The path is the taper,
    // the fill is a ramp that dies away at each end, and both are multiplied
    // into the strip as alpha. Nothing is ever painted over the image and then
    // partly erased, which is the whole class of hairline that a clip-then-cover
    // leaves behind at every antialiased edge it touches.
    const lo = vert ? PY : PX;
    const hi = lo + len;
    const gr = vert ? sx.createLinearGradient(0, lo, 0, hi)
                    : sx.createLinearGradient(lo, 0, hi, 0);
    gr.addColorStop(0, 'rgba(255,255,255,0)');
    gr.addColorStop(q, 'rgba(255,255,255,1)');
    gr.addColorStop(1 - q, 'rgba(255,255,255,1)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');

    sx.globalCompositeOperation = 'destination-in';
    sx.filter = bl > 0 ? 'blur(' + bl.toFixed(2) + 'px)' : 'none';
    sx.fillStyle = gr;
    sx.beginPath();
    const h = (hi - lo) / 2, mid = (lo + hi) / 2;   // one half-length
    if (vert) {
      const x0 = PX, x1 = PX + dLen;
      sx.moveTo(x0 + e, lo);
      sx.bezierCurveTo(x0 + e, lo + h / 3, x0, lo + 2 * h / 3, x0, mid);
      sx.bezierCurveTo(x0, mid + h / 3, x0 + e, mid + 2 * h / 3, x0 + e, hi);
      sx.lineTo(x1 - e, hi);
      sx.bezierCurveTo(x1 - e, hi - h / 3, x1, hi - 2 * h / 3, x1, mid);
      sx.bezierCurveTo(x1, mid - h / 3, x1 - e, mid - 2 * h / 3, x1 - e, lo);
    } else {
      const y0 = PY, y1 = PY + dLen;
      sx.moveTo(lo, y0 + e);
      sx.bezierCurveTo(lo + h / 3, y0 + e, lo + 2 * h / 3, y0, mid, y0);
      sx.bezierCurveTo(mid + h / 3, y0, mid + 2 * h / 3, y0 + e, hi, y0 + e);
      sx.lineTo(hi, y1 - e);
      sx.bezierCurveTo(hi - h / 3, y1 - e, hi - 2 * h / 3, y1, mid, y1);
      sx.bezierCurveTo(mid - h / 3, y1, mid - 2 * h / 3, y1 - e, lo, y1 - e);
    }
    sx.closePath();
    sx.fill();
    sx.filter = 'none';
    sx.globalCompositeOperation = 'source-over';

    ctx.globalAlpha = alpha;
    ctx.drawImage(sb, ix, iy);
    ctx.globalAlpha = 1;
  };

  for (let i = 0; i < n; i++) {
    const here = clamp01((vt - i * STAG) / STAG);
    const gone = dur > 0 ? clamp01((vt - (outAt + i * STAG)) / STAG) : 0;
    const a = here * (1 - gone);
    if (a <= 0.002) continue;
    const off = x[i] * A, filt = tone(i);
    strip(i, off, a, filt);
    if (P.wrap) { strip(i, off - len, a, filt); strip(i, off + len, a, filt); }
  }

  if (P.seams) {
    ctx.fillStyle = 'rgba(240,193,90,.5)';
    const th = Math.max(1, DPR * 0.75);
    for (let i = 0; i < n; i++) {
      if (vert) ctx.fillRect(fx + i * slot, fy + x[i] * A, th, fh);
      else      ctx.fillRect(fx + x[i] * A, fy + i * slot, fw, th);
    }
  }

  const a = Math.min(1, P.fade);
  const solid = BG + a + ')', clear = BG + '0)';

  // The two edges the strips never cross. Nothing slides off this way, so there
  // is no margin to dissolve into and the ramp has to sit inside the picture:
  // it eats the outermost strip or so at each side. Without it the row would
  // end flat, and the picture would read as a rectangle that had been cut up
  // rather than as something surfacing out of the dark.
  //
  // This ramp reaches FULL opacity at the picture's own edge — it does not stop
  // at `fade` the way the travel ramps do. A ramp that stops at 0.75 leaves the
  // outermost strip's straight edge showing through at a quarter strength, and
  // a quarter of a straight line is still a straight line: precisely the border
  // this is here to abolish. It is smoothstepped rather than linear for the same
  // reason the taper was — a linear ramp changes slope where it meets each of
  // its ends, and against a flat background those two kinks read as faint bands
  // of their own, which is a second edge in place of the one just removed.
  if (P.sides > 0) {
    const cross = vert ? fw : fh;
    const c0 = vert ? fx : fy;
    const ws = P.sides * cross;
    const over = Math.ceil(DPR);   // cover the edge's own antialiased pixel too
    const ax = (f2, t2) => vert ? ctx.createLinearGradient(f2, 0, t2, 0)
                                : ctx.createLinearGradient(0, f2, 0, t2);
    const ramp = (gr, rising) => {
      for (let j = 0; j <= 12; j++) {
        const u = j / 12, sm = u * u * (3 - 2 * u);
        gr.addColorStop(u, BG + (rising ? sm : 1 - sm).toFixed(4) + ')');
      }
    };
    let gr = ax(c0, c0 + ws); ramp(gr, false);
    ctx.fillStyle = gr;
    if (vert) ctx.fillRect(c0 - over, 0, ws + over, H);
    else      ctx.fillRect(0, c0 - over, W, ws + over);
    gr = ax(c0 + cross - ws, c0 + cross); ramp(gr, true);
    ctx.fillStyle = gr;
    if (vert) ctx.fillRect(c0 + cross - ws, 0, ws + over, H);
    else      ctx.fillRect(0, c0 + cross - ws, W, ws + over);
  }

  // The two edges the strips do cross. A strip sliding out past the picture's
  // own edge dissolves as it goes, so the excursion reads as the image coming
  // apart rather than as a rectangle sliding across black. The ramp is NOT
  // fully grown at the furthest a strip can reach — it completes `reach`
  // excursions out, past anything that will ever get there. A sine spends far
  // more of its time near its extremes than near its centre, so finishing the
  // ramp exactly at the extreme put each strip at its dimmest precisely when it
  // was at its stillest, and hid the one part of the motion worth watching.
  //
  // Either way it clears the picture entirely, so at the reunion, when every
  // strip is home, none of this touches it and it stays crisp.
  //
  // Each side is one fill. As a ramp band butted against a solid band, the two
  // meet on a fractional pixel where their partial coverages do not sum back to
  // one, and that leaves a faint seam down the join.
  if (a > 0 && A > 0) {
    const R = A * Math.max(1, P.reach);
    const lo  = vert ? fy : fx;
    const hi  = lo + len;
    const far = vert ? H : W;
    const axis = (f2, t2) => vert ? ctx.createLinearGradient(0, f2, 0, t2)
                                  : ctx.createLinearGradient(f2, 0, t2, 0);
    if (lo > 0) {
      const gr = axis(0, lo);
      gr.addColorStop(0, solid);
      gr.addColorStop(clamp01((lo - R) / lo), solid);
      gr.addColorStop(1, clear);
      ctx.fillStyle = gr;
      if (vert) ctx.fillRect(0, 0, W, lo); else ctx.fillRect(0, 0, lo, H);
    }
    if (far - hi > 0) {
      const gr = axis(hi, far);
      gr.addColorStop(0, clear);
      gr.addColorStop(clamp01(R / (far - hi)), solid);
      gr.addColorStop(1, solid);
      ctx.fillStyle = gr;
      if (vert) ctx.fillRect(0, hi, W, far - hi); else ctx.fillRect(hi, 0, far - hi, H);
    }
  }
}

function fit(c, w, h) { if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } }

// ---- the one control -----------------------------------------------------
// Two ways into the same switch. The whole viewport is a button and stays one,
// so "click anywhere" is true for as long as the piece is up — what changes is
// that once the invitation has been answered it stops being drawn, and a small
// mark appears in the corner so there is still something visible to aim at. The
// corner sits above the surface, so a click there toggles once, not twice.
const ICON = { play: 'M8 5v14l11-7z', pause: 'M6 5h4v14H6zM14 5h4v14h-4z' };
let started = false;

function setPlaying(on) {
  playing = on;
  if (on) started = true;
  if (media.kind === 'video') on ? vid.play().catch(() => {}) : vid.pause();
  togI.setAttribute('d', on ? ICON.pause : ICON.play);
  tog.setAttribute('aria-label', on ? 'pause' : 'play');
  document.body.dataset.state = on ? 'playing' : started ? 'paused' : 'idle';
}
const toggle = () => { last = performance.now(); setPlaying(!playing); };
start.addEventListener('click', toggle);
tog.addEventListener('click', toggle);

// space too, unless a button already has focus and is handling it itself
window.addEventListener('keydown', e => {
  const on = document.activeElement;
  if (e.key === ' ' && on !== start && on !== tog) { e.preventDefault(); toggle(); }
});

// ---- sources -------------------------------------------------------------
function useVideo(src, file) {
  media = { kind: 'video', el: vid };
  vid.src = src;
  vid.playbackRate = 1;
  if (playing) vid.play().catch(() => {});
  vid.addEventListener('loadedmetadata', () => {
    DUR = isFinite(vid.duration) ? vid.duration : 0;
    if (file) listen(file);
    else apply(fitTempo(SOURCE.bpm, SOURCE.beats, MUSIC.perBar, DUR));
  }, { once: true });
}

function useImage(url) {
  const img = new Image();
  img.onload = () => { media = { kind: 'image', el: img }; };
  img.src = url;
  vid.pause();
}

// drop any file on the page to cut that instead — no visible affordance
const swallow = e => { e.preventDefault(); e.stopPropagation(); };
window.addEventListener('dragover', e => { swallow(e); document.body.classList.add('dropping'); });
window.addEventListener('dragleave', e => { swallow(e); document.body.classList.remove('dropping'); });
window.addEventListener('drop', e => {
  swallow(e);
  document.body.classList.remove('dropping');
  const f = e.dataTransfer.files[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  if (f.type.startsWith('video')) { useVideo(url, f); setPlaying(true); }
  else if (f.type.startsWith('image')) useImage(url);
});

vid.muted = false;
useVideo(SOURCE.src);
setPlaying(false);
resize();
requestAnimationFrame(frame);
