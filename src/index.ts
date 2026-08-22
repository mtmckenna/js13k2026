// UNICORN STORM -- a call-and-response rhythm game.
//
// The herd plays a phrase on the beat; you play it back. Getting it right makes
// everything bigger: taller arcs, fatter ribbons, louder fireworks.
//
// Pitch belongs to the unicorn (one note each), so recall is one axis: WHICH, and WHEN.
//
// The row itself never moves. Each note spawns a flying COPY that arcs, bounces off
// its fellows and the walls, and falls through the floor. Positional recall depends on
// the row staying put, and transient copies are far simpler than sending originals home.

const NOTES = [261.63, 293.66, 329.63, 392.0, 440.0]; // C D E G A -- major pentatonic
const HUES = [350, 35, 120, 205, 280];
const VOICES = ["triangle", "sine", "triangle", "sine", "triangle"];
const COUNT = NOTES.length;

const SIZE = 1.55;
const HIT = 38 * SIZE;
const G = 1500;
const BOUNCE = 0.96;

const BPM = 80;
const BEAT = 60 / BPM;
const WINDOW = 0.36; // how far off the beat still counts, in seconds
// Ceremony is expensive. A 2-note phrase takes ~1.5s to play, so multi-bar
// countdowns around it meant waiting far longer than playing.
// Every countdown reads 3, 2, 1 -- the same shape before the herd plays and before
// your turn, so there's one rhythm to learn rather than three.
// One beat between the phrase ending and your turn -- just enough that the herd's
// last note doesn't blur into your first. A longer gap was dead air: the response
// clock starts on your tap anyway, so there is nothing to count you in to.
const REST = 1;
const LEADIN = 3; // countdown before the herd plays
const LEADIN_NEXT = 3;

const canvas: HTMLCanvasElement = document.createElement("canvas");
const ctx: CanvasRenderingContext2D = canvas.getContext("2d");
document.body.appendChild(canvas);

let W = 0;
let H = 0;
let groundY = 0;
let slot = 0;

// --- cast ----------------------------------------------------------------

interface Ribbon {
  hue: number;
  pts: number[];
  age: number;
  fat: number;
}

// A unicorn standing in the row. Never leaves.
interface Unicorn {
  homeX: number;
  hue: number;
  voice: string;
  gait: number; // where in the stride this one stands
  bob: number;
  lit: number; // fades after being played, so the eye can follow the call
}

// A flying copy. Lives from launch until it drops off the bottom.
interface Flyer {
  x: number;
  y: number;
  vx: number;
  vy: number;
  hue: number;
  gait: number;
  idx: number; // which unicorn -- so a collision can sound their two notes
  glow: number;
  hot: boolean; // launched by a correct note -- only these can score a collision bonus
  ribbon: Ribbon;
}

const herd: Unicorn[] = [];
for (let i = 0; i < COUNT; i++) {
  // Spread across the cycle by golden-ish steps so no two look alike or line up.
  herd.push({ homeX: 0, hue: HUES[i], voice: VOICES[i], gait: i * 2.4, bob: Math.random() * 6.28, lit: 0 });
}

const flyers: Flyer[] = [];
const ribbons: Ribbon[] = [];

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  hue: number;
  age: number;
  life: number;
  white: boolean;
}
const sparks: Spark[] = [];
const flashes: { x: number; y: number; age: number; r: number }[] = [];

// Big banded arcs behind everything. Reserved for high scores so they stay an event.
const bows: { x: number; y: number; r: number; age: number; life: number }[] = [];

// Drifting cloud bank. Three parallax layers -- far ones small, slow and faint --
// so the sky has depth and motion even when nothing is happening.
interface Cloud {
  x: number;
  y: number;
  s: number;
  v: number;
  a: number;
  k: number; // shape variation
}
const clouds: Cloud[] = [];

// Lightning. Frequency and brightness both track `flourish`, so a good run turns the
// weather up: sparse and dim when you're scraping through, near-constant at a storm.
const bolts: { pts: number[]; age: number; life: number; power: number }[] = [];
let flashA = 0;
let boltTimer = 2;

function strike(power: number) {
  const x0 = 40 + Math.random() * (W - 80);
  const pts = [x0, -12];
  let x = x0;
  let y = -12;
  const steps = 6 + ((Math.random() * 4) | 0);
  const dy = (groundY * 0.8) / steps;
  for (let i = 0; i < steps; i++) {
    x += (Math.random() - 0.5) * 95;
    y += dy * (0.7 + Math.random() * 0.6);
    pts.push(x, y);
  }
  bolts.push({ pts, age: 0, life: 0.3 + Math.random() * 0.22, power });
  flashA = Math.max(flashA, 0.12 + power * 0.3);
  rumble(power);
}

function seedClouds() {
  clouds.length = 0;
  for (let i = 0; i < 15; i++) {
    const layer = i % 3;
    clouds.push({
      x: Math.random() * (W + 500) - 250,
      y: H * (0.04 + Math.random() * 0.56),
      s: (0.55 + layer * 0.5) * (0.75 + Math.random() * 0.6),
      v: 4 + layer * 8 + Math.random() * 5,
      a: 0.07 + layer * 0.05,
      k: Math.random(),
    });
  }
}

// Angular, faceted clouds rather than puffy ones -- same language as the herd.
function drawCloud(c: Cloud, lift: number) {
  const w = 150 * c.s;
  const h = 40 * c.s;
  const j = c.k * 0.16;
  ctx.save();
  ctx.translate(c.x, c.y);
  poly([
    -w * 0.5, h * 0.5,
    -w * 0.42, -h * 0.1,
    -w * 0.2, -h * (0.42 + j),
    w * 0.02, -h * (0.62 - j),
    w * 0.26, -h * (0.38 + j),
    w * 0.44, -h * 0.08,
    w * 0.5, h * 0.5,
  ]);
  ctx.fillStyle = `hsla(214,42%,${64 + lift * 14}%,${c.a})`;
  ctx.fill();
  // lit upper plane
  poly([
    -w * 0.2, -h * (0.42 + j),
    w * 0.02, -h * (0.62 - j),
    w * 0.26, -h * (0.38 + j),
    w * 0.02, -h * 0.16,
  ]);
  ctx.fillStyle = `hsla(206,60%,${78 + lift * 12}%,${c.a * 0.85})`;
  ctx.fill();
  ctx.restore();
}
const BANDS = [0, 28, 52, 120, 200, 250, 288];

function rainbow(x: number, y: number, r: number, life: number) {
  bows.push({ x, y, r, age: 0, life });
}

// Floating judgement text. Without this the player has no idea whether they were
// close or wildly off -- and a rhythm game you can't read is a rhythm game you
// can't improve at.
interface Label {
  x: number;
  y: number;
  s: string;
  col: string;
  age: number;
  size: number;
}
const labels: Label[] = [];

function say(x: number, y: number, s: string, col: string, size: number) {
  labels.push({ x, y, s, col, age: 0, size });
}

// Hit rects for the two on-screen controls. Kept as state so drawing and hit
// testing can never disagree about where a button is.
const playBtn = { x: 0, y: 0, w: 0, h: 0 };
const restartBtn = { x: 0, y: 0, w: 0, h: 0 };
const againBtn = { x: 0, y: 0, w: 0, h: 0 };
const nextBtn = { x: 0, y: 0, w: 0, h: 0 };
const shareBtn = { x: 0, y: 0, w: 0, h: 0 };
const replayBtn = { x: 0, y: 0, w: 0, h: 0 };
const blindBtn = { x: 0, y: 0, w: 0, h: 0 };
const makeBtn = { x: 0, y: 0, w: 0, h: 0 };
const clearBtn = { x: 0, y: 0, w: 0, h: 0 };
const sendBtn = { x: 0, y: 0, w: 0, h: 0 };
const backBtn = { x: 0, y: 0, w: 0, h: 0 };
const hearBtn = { x: 0, y: 0, w: 0, h: 0 };
let restartArm = -1; // restart asks for confirmation; this is when that offer expires

function inRect(x: number, y: number, r: { x: number; y: number; w: number; h: number }) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

// iOS ignores user-scalable=no, so double-tap and pinch still zoom and pan the page.
// These are the events that actually carry it.
for (const ev of ["gesturestart", "gesturechange", "gestureend", "dblclick"]) {
  addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}

// Probe for the notch/status-bar inset. env() is only reachable from CSS, so measure
// an element sized by it rather than guessing a constant.
const probe = document.createElement("div");
probe.style.cssText =
  "position:fixed;top:0;left:0;width:0;pointer-events:none;height:env(safe-area-inset-top,0px)";
document.body.appendChild(probe);
let topPad = 0;

function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  // visualViewport tracks the area actually visible as Safari's toolbars slide in and
  // out; innerHeight lags behind it and leaves a dead strip at the bottom.
  const vv = (window as any).visualViewport;
  W = Math.round(vv ? vv.width : innerWidth);
  H = Math.round(vv ? vv.height : innerHeight);
  topPad = probe.offsetHeight || 0;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  groundY = H * 0.82;
  slot = W / (COUNT + 1);
  if (!clouds.length) seedClouds();
  for (let i = 0; i < herd.length; i++) herd[i].homeX = slot * (i + 1);

  playBtn.w = Math.min(260, W * 0.62);
  playBtn.h = 62;
  playBtn.x = (W - playBtn.w) / 2;
  playBtn.y = H * 0.4;

  // Top-left, well clear of the herd: a stray gameplay tap must never restart a run.
  restartBtn.w = 92;
  restartBtn.h = 34;
  restartBtn.x = 12;
  restartBtn.y = 12 + topPad;

  shareBtn.w = 82;
  shareBtn.h = 34;
  shareBtn.x = W - 94;
  shareBtn.y = 12 + topPad;

  // End-of-round choice, side by side and equally reachable.
  const gw = Math.min(168, (W - 56) / 2);
  const gh = 56;
  const gy = H * 0.2 + 76;
  againBtn.w = nextBtn.w = gw;
  againBtn.h = nextBtn.h = gh;
  againBtn.y = nextBtn.y = gy;
  againBtn.x = W / 2 - gw - 8;
  nextBtn.x = W / 2 + 8;

  makeBtn.w = Math.min(230, W * 0.56);
  makeBtn.h = 44;
  makeBtn.x = (W - makeBtn.w) / 2;
  makeBtn.y = playBtn.y + playBtn.h + 76;

  // Four across: hear it, wipe it, copy it, leave.
  const cw = Math.min(120, (W - 60) / 4);
  const cy = groundY - 122;
  hearBtn.w = clearBtn.w = sendBtn.w = backBtn.w = cw;
  hearBtn.h = clearBtn.h = sendBtn.h = backBtn.h = 46;
  hearBtn.y = clearBtn.y = sendBtn.y = backBtn.y = cy;
  const row = W / 2 - (cw * 4 + 24) / 2;
  hearBtn.x = row;
  clearBtn.x = row + cw + 8;
  sendBtn.x = row + (cw + 8) * 2;
  backBtn.x = row + (cw + 8) * 3;

  const sw = Math.min(168, (W - 56) / 2);
  blindBtn.w = replayBtn.w = sw;
  blindBtn.h = replayBtn.h = 40;
  blindBtn.y = replayBtn.y = gy + gh + 12;
  blindBtn.x = W / 2 - sw - 8;
  replayBtn.x = W / 2 + 8;
}
addEventListener("resize", resize);
addEventListener("orientationchange", resize);
{
  const vv = (window as any).visualViewport;
  if (vv) {
    vv.addEventListener("resize", resize);
    vv.addEventListener("scroll", resize);
  }
}

// Coming back from another app or an unlocked screen should recover on its own,
// without the player having to discover that a tap is required.
addEventListener("visibilitychange", () => {
  if (!document.hidden && ac) ensureAudio();
});

// --- audio ---------------------------------------------------------------
// Everything is scheduled against ac.currentTime. setTimeout drifts, and drift is
// fatal to a rhythm game -- the whole design rests on this clock being the master.

let ac: AudioContext;

function note(freq: number, voice: string, when: number, vol: number) {
  const t = Math.max(when, ac.currentTime);
  const gain = ac.createGain();
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(vol, t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0005, t + 1.0);
  gain.connect(ac.destination);
  for (let i = 0; i < 2; i++) {
    const osc = ac.createOscillator();
    osc.type = (i ? "sine" : voice) as OscillatorType;
    osc.frequency.value = freq * (i ? 2.005 : 1);
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + 1.1);
  }
}

// Quiet metronome click. Without an audible pulse there is nothing to play "on".
function click(when: number, strong: boolean) {
  const t = Math.max(when, ac.currentTime);
  const gain = ac.createGain();
  gain.gain.setValueAtTime(strong ? 0.09 : 0.045, t);
  gain.gain.exponentialRampToValueAtTime(0.0005, t + 0.06);
  gain.connect(ac.destination);
  const osc = ac.createOscillator();
  osc.type = "square";
  osc.frequency.value = strong ? 1600 : 1100;
  osc.connect(gain);
  osc.start(t);
  osc.stop(t + 0.07);
}

// Two unicorns meeting should sound like the pair of them. The scale is major
// pentatonic, so ANY two of these notes are already consonant -- the only muddy case
// is two adjacent degrees stacked close, so the lower voice is placed an octave below
// the upper one. That turns a major 2nd into a 9th: open and bell-like, never a clash.
function chime(a: number, b: number, vol: number) {
  const lo = NOTES[Math.min(a, b)] * 2;
  const hi = NOTES[Math.max(a, b)] * 4;
  const t = ac.currentTime;
  for (const f of [lo, hi]) {
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.85);
    g.connect(ac.destination);
    const o = ac.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(f, t);
    // A touch of upward drift for sparkle, far too small to bend the interval.
    o.frequency.linearRampToValueAtTime(f * 1.02, t + 0.5);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.9);
  }
}

// Thunder: filtered noise, deliberately quiet and delayed a beat behind the flash so
// it sits under the music instead of competing with it.
let noiseBuf: AudioBuffer;
function rumble(power: number) {
  if (!ac || ac.state !== "running") return;
  if (!noiseBuf) {
    noiseBuf = ac.createBuffer(1, (ac.sampleRate * 0.8) | 0, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = ac.createBufferSource();
  src.buffer = noiseBuf;
  const lp = ac.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 190 + power * 200;
  const g = ac.createGain();
  const t = ac.currentTime + 0.08 + Math.random() * 0.25;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.055 * power, t + 0.06);
  g.gain.exponentialRampToValueAtTime(0.0004, t + 0.75);
  src.connect(lp).connect(g).connect(ac.destination);
  src.start(t);
  src.stop(t + 0.85);
}

function ping(freq: number, vol: number) {
  const t = ac.currentTime;
  const gain = ac.createGain();
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.0005, t + 0.5);
  gain.connect(ac.destination);
  const osc = ac.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(freq * 1.6, t + 0.45);
  osc.connect(gain);
  osc.start(t);
  osc.stop(t + 0.55);
}

// --- game state ----------------------------------------------------------

const TITLE = 0;
const CALL = 1;
const RESPOND = 2;
const GRADE = 3;
const REPLAY = 4;
const COMPOSE = 5;

let phase = TITLE;
let phaseAt = 0; // audio-clock time this phase began
let seq: number[] = [];
// Beat offset of each note from the phrase start. Uniform 1-beat spacing to begin
// with; longer phrases earn held notes and then off-beat pairs.
let offs: number[] = [];

// Gap before the note being added. Straight quarter notes for a long time: the first
// six notes are pure which-and-when, with no rhythm to learn on top. Held notes come
// next because they are EASIER (more room), and off-beats only once you are deep in.
function nextGap(len: number) {
  if (len < 7) return 1;
  const pool = len < 10 ? [1, 1, 1, 1, 2] : [1, 1, 1, 1, 2, 2, 0.5];
  return pool[(Math.random() * pool.length) | 0];
}

function phraseBeats() {
  return offs[offs.length - 1];
}

// A half-beat gap is 375ms, so the flat +/-360ms window would swallow its neighbour.
// Never let the window exceed 45% of the tightest gap in this phrase.
function windowFor() {
  let min = 9;
  for (let i = 1; i < offs.length; i++) min = Math.min(min, offs[i] - offs[i - 1]);
  return Math.min(WINDOW, min * BEAT * 0.48);
}
let round = 0;
let best = 0; // longest phrase reached
let bestScore = 0;
let bestClean = 0; // longest phrase reached without a single retry
let streak = 0; // rounds advanced in a row without retrying
let mult = 1;
let retries = 0;

// Persisted across visits. Wrapped: Safari private mode throws on access.
function loadBest() {
  try {
    best = +localStorage.us_l || 0;
    bestScore = +localStorage.us_s || 0;
    bestClean = +localStorage.us_c || 0;
  } catch (e) {}
}
function saveBest() {
  try {
    localStorage.us_l = best;
    localStorage.us_s = bestScore;
    localStorage.us_c = bestClean;
  } catch (e) {}
}

let schedIdx = 0; // notes handed to the audio clock
let visIdx = 0; // notes animated
let clickIdx = 0;

let judged: number[] = []; // per-slot score, -1 = not yet attempted
let accuracy = 0; // last round
let flourish = 0; // 0..1 -- drives how big everything gets
let message = "";
let score = 0;
let grew = true; // did the last round earn a new note?
const PASS = ["nice", "good ear", "well played", "the herd approves"];
const FAIL = ["not quite", "so close", "almost had it"];
let combo = 0; // midair crossings this round
let cued = false; // "your turn" cue scheduled?
let goAt = -9; // audio time the turn began, for the GO flourish

// Every tap of the turn, as (unicorn, seconds after the downbeat). This is the whole
// round: seq + offs say what was asked, taps say what was actually played.
let taps: { i: number; dt: number }[] = [];
let replayEnd = 0;
let sharedIn = false; // arrived via a shared replay link

// Compact enough for a URL hash: notes as digits, gaps as one char each, and every
// tap as a digit plus two base36 chars of 20ms units.
function encodeRun() {
  let g = "";
  for (let i = 1; i < offs.length; i++) {
    const d = offs[i] - offs[i - 1];
    g += d === 0.5 ? "0" : d === 2 ? "2" : "1";
  }
  let t = "";
  for (const p of taps) {
    const u = Math.min(1295, Math.max(0, Math.round(p.dt * 50)));
    t += p.i + ("0" + u.toString(36)).slice(-2);
  }
  return seq.join("") + "." + g + "." + t;
}

function decodeRun(code: string) {
  try {
    const [a, g, t] = code.split(".");
    if (!a || a.length < 2) return false;
    const q = a.split("").map(Number);
    if (q.some((v) => !(v >= 0 && v < COUNT))) return false;
    const o = [0];
    for (let i = 0; i < g.length; i++) o.push(o[i] + (g[i] === "0" ? 0.5 : g[i] === "2" ? 2 : 1));
    if (o.length !== q.length) return false;
    const tp = [];
    for (let i = 0; i + 2 < t.length; i += 3) {
      const u = +t[i];
      if (!(u >= 0 && u < COUNT)) return false;
      tp.push({ i: u, dt: parseInt(t.slice(i + 1, i + 3), 36) / 50 });
    }
    seq = q;
    offs = o;
    taps = tp;
    judged = seq.map(() => -1);
    return true;
  } catch (e) {
    return false;
  }
}

// Plays the round back exactly as it happened: the herd's phrase, then the attempt,
// with its real timing errors intact. Hearing your own rushing is worth more than
// being told about it.
function startReplay(now: number) {
  const t0 = now + BEAT;
  pending.length = 0;
  for (let k = 0; k < seq.length; k++) {
    const at = t0 + offs[k] * BEAT;
    note(NOTES[seq[k]], herd[seq[k]].voice, at, 0.24);
    pending.push({ at, i: seq[k], power: 0.7 });
  }
  const gap = (offs[offs.length - 1] + REST) * BEAT;
  for (const p of taps) {
    const at = t0 + gap + p.dt;
    note(NOTES[p.i], herd[p.i].voice, at, 0.22);
    pending.push({ at, i: p.i, power: 0.7 });
  }
  const lastTap = taps.length ? taps[taps.length - 1].dt : 0;
  replayEnd = t0 + gap + lastTap + 1.4;
  phase = REPLAY;
}
// The response clock starts on the player's FIRST tap, not on a countdown. The
// opening note is therefore a gimme: it can't be early or late, it just sets the
// beat everything after it is measured against.
let turnAt = -1; // -1 until they commit; then the origin of their phrase
let pulseAt = 0; // what the metronome and ground flash are anchored to

// Grow by APPENDING one note, never by regenerating. A fresh random phrase every
// round is a memory test with no memory in it -- the whole gentleness of Simon comes
// from the phrase you already know staying put, with one new note on the end.
function newRound(now: number, grow: boolean, keep?: boolean) {
  // Retrying is always allowed, but it costs the streak. That's the whole answer to
  // "how do we tell a clean run from a farmed one" -- no bans, just a price.
  if (!keep) {
    if (!grow) {
      streak = 0;
      retries++;
    } else if (round > 0) {
      streak++;
    }
    mult = Math.min(5, 1 + streak * 0.5);
  }

  if (keep) {
    // a pattern arrived from someone else -- play it as given
  } else if (!seq.length) {
    seq = [(Math.random() * COUNT) | 0, (Math.random() * COUNT) | 0];
    offs = [0, 1];
  } else if (grow) {
    seq.push((Math.random() * COUNT) | 0);
    offs.push(phraseBeats() + nextGap(seq.length));
  }

  judged = seq.map(() => -1);
  taps = [];
  schedIdx = visIdx = 0;
  clickIdx = round === 0 ? -LEADIN : -LEADIN_NEXT; // click through the countdown to set tempo
  cued = false;
  combo = 0;
  pending.length = 0;
  bows.length = 0;
  phase = CALL;
  const lead = round === 0 ? LEADIN : LEADIN_NEXT;
  phaseAt = now + BEAT * lead;
  pulseAt = phaseAt;
  turnAt = -1;
  flourish = accuracy; // the herd shows off in proportion to how you last did
  message = "";
  round++;
}

// How hard the game should be showing off right now. Accuracy alone maxes out on
// the first correct note and leaves the spectacle nowhere to build, so weight it by
// how deep into the phrase they are: "closer to getting it right" means both clean
// AND nearly done.
function heat() {
  let sum = 0;
  let n = 0;
  for (const j of judged) if (j >= 0) (sum += j), n++;
  if (!n) return 0;
  return (sum / n) * (0.3 + 0.7 * (n / seq.length));
}

// Leaps queued for the future -- lets a celebration play out as a phrase rather
// than everything firing on one frame.
const pending: { at: number; i: number; power: number; x?: number; hue?: number }[] = [];

// The verdict, performed. How hard the herd parties and how bright the chord is
// both scale with the score: a scrape through should not look like a triumph.
function celebrate(a: number, now: number) {
  const t = now + 0.05;
  const climb = [261.63, 329.63, 392.0, 523.25, 659.25];

  if (a >= 0.95) {
    // The storm. Rainbows, fireworks, and unicorns erupting the length of the field.
    strike(1);
    for (let i = 0; i < 3; i++) rainbow(W * (0.18 + 0.32 * i), groundY, W * (0.3 + 0.11 * i), 2.8);

    for (let i = 0; i < 5; i++) {
      note(climb[i], "triangle", t + i * 0.1, 0.24);
      pending.push({ at: t + i * 0.1, i, power: 1 });
    }
    note(523.25, "sine", t + 0.58, 0.2);
    note(659.25, "sine", t + 0.58, 0.18);
    note(783.99, "sine", t + 0.58, 0.16);

    // A crowd from nowhere -- not the five in the row, but new arrivals all over.
    for (let k = 0; k < 16; k++) {
      pending.push({
        at: t + 0.12 + k * 0.055,
        i: 0,
        power: 0.55 + Math.random() * 0.55,
        x: 40 + Math.random() * (W - 80),
        hue: HUES[(Math.random() * COUNT) | 0],
      });
    }

    for (let i = 0; i < COUNT; i++) {
      burst(slot * (i + 1), groundY - H * 0.34 * Math.random() - 70, i, (i + 2) % COUNT, 1);
    }
  } else if (a >= 0.9) {
    // Rainbows, but calm ones -- the tier above has somewhere left to go.
    for (let i = 0; i < 2; i++) rainbow(W * (0.32 + 0.36 * i), groundY, W * (0.28 + 0.1 * i), 2.4);
    for (let i = 0; i < 4; i++) {
      note(climb[i], "triangle", t + i * 0.11, 0.22);
      pending.push({ at: t + i * 0.11, i, power: 0.9 });
    }
    for (let k = 0; k < 5; k++) {
      pending.push({
        at: t + 0.18 + k * 0.09,
        i: 0,
        power: 0.5 + Math.random() * 0.4,
        x: 40 + Math.random() * (W - 80),
        hue: HUES[(Math.random() * COUNT) | 0],
      });
    }
  } else if (a >= 0.8) {
    const climb = [261.63, 329.63, 392.0];
    for (let i = 0; i < 3; i++) {
      note(climb[i], "triangle", t + i * 0.12, 0.2);
      pending.push({ at: t + i * 0.12, i: (i * 2) % COUNT, power: 0.8 });
    }
  } else if (a >= 0.5) {
    note(261.63, "sine", t, 0.16);
    note(392.0, "sine", t + 0.14, 0.16);
    pending.push({ at: t, i: 2, power: 0.45 });
  } else {
    // Falling minor third, quiet. Disappointment, not a buzzer.
    note(196.0, "sine", t, 0.13);
    note(155.56, "sine", t + 0.16, 0.12);
  }
}

function respondStart() {
  return phaseAt + (phraseBeats() + REST) * BEAT;
}

// --- leaping -------------------------------------------------------------

// Exaggeration is the reward: arcs swell with `power`, which tracks how well the
// player is doing right now.
function launch(x: number, hue: number, power: number, dir: number, hot?: boolean, idx?: number) {
  const peak = H * (0.2 + power * 0.34);
  const vy = Math.sqrt(2 * G * peak);
  const flight = (2 * vy) / G;
  const reach = peak * 1.7;
  if (x + dir * reach < 40 || x + dir * reach > W - 40) dir = -dir;

  const ribbon = { hue, pts: [], age: 0, fat: 0.6 + power };
  ribbons.push(ribbon);
  flyers.push({
    x,
    y: groundY - 6,
    vx: (dir * reach) / flight,
    vy: -vy,
    hue,
    // Airborne copies keep a stride too, and a random one for crowd extras.
    gait: idx === undefined ? Math.random() * 6.28 : herd[idx].gait,
    idx: idx === undefined ? HUES.indexOf(hue) : idx,
    glow: 0.3 + power * 0.7,
    hot: !!hot,
    ribbon,
  });
}

function leap(i: number, power: number, hot?: boolean) {
  const u = herd[i];
  // Alternate by index so neighbours sweep opposite ways and their arcs can meet.
  launch(u.homeX, u.hue, power, i % 2 ? -1 : 1, hot, i);
  u.lit = 1;
}

function burst(x: number, y: number, i1: number, i2: number, power: number) {
  const h1 = HUES[i1];
  const h2 = HUES[i2];
  flashes.push({ x, y, age: 0, r: 60 + power * 90 });
  const n = 30 + ((power * 90) | 0);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * 6.284;
    const s = (110 + Math.random() * Math.random() * 300) * (0.7 + power * 0.8);
    sparks.push({
      x,
      y,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s,
      hue: Math.random() < 0.5 ? h1 : h2,
      age: 0,
      life: 0.7 + Math.random() * 0.8,
      white: i % 7 === 0,
    });
  }
  if (ac) chime(i1, i2, 0.05 + power * 0.09);
}

// --- input ---------------------------------------------------------------

let unlocked = false;

function ensureAudio() {
  if (!ac) ac = new (window.AudioContext || (window as any).webkitAudioContext)();
  // Any state that isn't "running" needs a resume. Checking only for "suspended"
  // missed Safari's "interrupted" state, which left the overlay permanently stuck:
  // the message said tap to resume, and the tap genuinely did nothing.
  if (ac.state !== "running") {
    try {
      ac.resume();
    } catch (e) {}
  }
  if (!unlocked) {
    unlocked = true;
    // Silent blip. Some mobile browsers leave the clock parked until a node has
    // actually run, and every timing decision in this game reads that clock.
    const g = ac.createGain();
    g.gain.value = 0;
    g.connect(ac.destination);
    const o = ac.createOscillator();
    o.connect(g);
    o.start();
    o.stop(ac.currentTime + 0.05);
  }
}

// Sound a unicorn without any of the grading machinery -- what the title screen
// offers so the instrument can be learned before it's tested.
function freePlay(i: number) {
  ensureAudio();
  note(NOTES[i], herd[i].voice, ac.currentTime, 0.2);
  leap(i, 0.35);
}

// Take on a pattern somebody sent, instead of a generated one.
let compAt = -1; // audio time of the first note laid down

function enterCompose() {
  ensureAudio();
  seq = [];
  offs = [];
  taps = [];
  compAt = -1;
  phase = COMPOSE;
  phaseAt = ac.currentTime;
  // Click straight away: you need the beat before the first note, not after it.
  pulseAt = ac.currentTime;
  clickIdx = 0;
  message = "";
}

// Notes land on the nearest half beat. Free-form timing would encode fine but would
// be almost impossible for a friend to play back, and unplayable patterns are not
// a challenge, just a wall.
function composeTap(i: number) {
  if (seq.length >= 16) return;
  const now = ac.currentTime;
  if (compAt < 0) {
    compAt = now;
    pulseAt = now;
    clickIdx = 0;
    offs.push(0);
  } else {
    let o = Math.round((now - compAt) / (BEAT * 0.5)) * 0.5;
    const last = offs[offs.length - 1];
    if (o <= last) o = last + 0.5;
    offs.push(o);
  }
  seq.push(i);
  note(NOTES[i], herd[i].voice, now, 0.22);
  leap(i, 0.5);
}

// Copies the bare URL and nothing else. Copying a whole sentence means pasting prose
// into a URL bar, and the old code also claimed success on paths where it had copied
// nothing at all.
function copyLink(url: string, y: number) {
  const done = (good: boolean) =>
    say(
      W / 2,
      y,
      good ? "link copied" : "couldn't copy",
      good ? "rgba(180,255,210,1)" : "rgba(255,170,170,1)",
      22
    );
  const nav = navigator as any;
  try {
    if (nav.clipboard && nav.clipboard.writeText) {
      nav.clipboard.writeText(url).then(() => done(true), () => done(legacyCopy(url)));
      return;
    }
  } catch (e) {}
  done(legacyCopy(url));
}

// Older Safari refuses the async clipboard outside narrow conditions; a selected
// off-screen textarea still works there.
function legacyCopy(url: string) {
  try {
    const ta = document.createElement("textarea");
    ta.value = url;
    ta.style.cssText = "position:fixed;top:-99px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

function runUrl() {
  return location.origin + location.pathname + "#" + encodeRun();
}

// Play the pattern back so you can hear what you've written before sending it.
function previewPattern(now: number) {
  if (!seq.length) return;
  pending.length = 0;
  const t0 = now + 0.35;
  for (let k = 0; k < seq.length; k++) {
    const at = t0 + offs[k] * BEAT;
    note(NOTES[seq[k]], herd[seq[k]].voice, at, 0.24);
    pending.push({ at, i: seq[k], power: 0.65 });
  }
  // Re-anchor the click to the playback so the pattern lands on the pulse.
  pulseAt = t0;
  clickIdx = 0;
}

function sendPattern() {
  if (seq.length < 2) return;
  taps = []; // a pattern is the challenge, not a performance
  copyLink(runUrl(), H * 0.5);
}

// Retry the same phrase without sitting through the herd playing it again. Once you
// know the phrase, the preview is just a wait.
function retryBlind(now: number) {
  streak = 0;
  retries++;
  mult = 1;
  judged = seq.map(() => -1);
  taps = [];
  combo = 0;
  pending.length = 0;
  bows.length = 0;
  schedIdx = visIdx = seq.length; // nothing left to schedule or animate
  cued = true;
  clickIdx = 0;
  phase = RESPOND;
  phaseAt = now;
  pulseAt = now;
  turnAt = -1;
  goAt = now;
  flourish = 0;
  message = "";
  round++;
}

function startChallenge() {
  ensureAudio();
  const go = () => {
    score = 0;
    streak = 0;
    mult = 1;
    retries = 0;
    round = 0;
    accuracy = 0;
    flourish = 0;
    restartArm = -1;
    newRound(ac.currentTime, true, true);
  };
  if (ac.state === "running") go();
  else {
    let done = false;
    const once = () => {
      if (!done) {
        done = true;
        go();
      }
    };
    ac.resume().then(once, once);
    setTimeout(once, 400);
  }
}

function startRun() {
  ensureAudio();

  const go = () => {
    seq = [];
    score = 0;
    accuracy = 0;
    flourish = 0;
    round = 0;
    restartArm = -1;
    streak = 0;
    mult = 1;
    retries = 0;
    newRound(ac.currentTime, true);
  };

  // On iOS a new AudioContext is suspended and currentTime does NOT advance until it
  // is running. Anchoring the round to a parked clock froze the countdown mid-"3" and
  // needed a second tap to shake loose. Wait for the clock to actually tick.
  if (ac.state === "running") {
    go();
  } else {
    let started = false;
    const once = () => {
      if (started) return;
      started = true;
      go();
    };
    ac.resume().then(once, once);
    setTimeout(once, 400); // never hang if resume() refuses to settle
  }
}

function tap(i: number) {
  ensureAudio();
  const now = ac.currentTime;

  // Hands off while the herd counts in and plays: a stray note muddles the phrase
  // you're trying to memorise, and nothing tapped here could count anyway.
  if (phase === CALL) return;

  if (phase !== RESPOND) {
    note(NOTES[i], herd[i].voice, now, 0.2);
    leap(i, 0.35);
    return;
  }

  note(NOTES[i], herd[i].voice, now, 0.22);

  // Which beat was this aimed at?
  const lx = herd[i].homeX;
  const ly = groundY - 60;

  // First tap of the turn: anchor everything to it and re-phase the pulse so the
  // metronome follows the player instead of arguing with them.
  if (turnAt < 0) {
    turnAt = now;
    pulseAt = now;
    clickIdx = 0;
    taps.push({ i, dt: 0 });
    const ok = seq[0] === i;
    judged[0] = ok ? 1 : 0;
    if (ok) {
      score += Math.round(100 * mult);
      say(lx, ly, "go!", "rgba(160,255,190,1)", 24);
    } else {
      say(lx, ly, "wrong one", "rgba(255,110,120,.95)", 17);
    }
    flourish = heat();
    leap(i, ok ? 0.35 + flourish : 0.2, ok);
    return;
  }

  // Slots are no longer evenly spaced, so find the nearest unclaimed one rather
  // than dividing by the beat.
  let k = -1;
  let bestOff = 1e9;
  for (let j = 0; j < seq.length; j++) {
    if (judged[j] >= 0) continue;
    const d = Math.abs(now - (turnAt + offs[j] * BEAT));
    if (d < bestOff) {
      bestOff = d;
      k = j;
    }
  }
  taps.push({ i, dt: now - turnAt });

  const win = windowFor();
  if (k < 0 || bestOff > win) {
    leap(i, 0.3);
    flourish = Math.max(0, flourish - 0.15);
    say(lx, ly, "extra", "rgba(255,255,255,.5)", 15);
    return;
  }
  const delta = now - (turnAt + offs[k] * BEAT); // signed: <0 early, >0 late
  const off = Math.abs(delta);
  const timing = Math.max(0, 1 - off / win);
  const right = seq[k] === i;
  judged[k] = right ? timing : 0;

  // Name the error, and say which way. "EARLY" is actionable; a red dot isn't.
  if (!right) {
    say(lx, ly, "wrong one", "rgba(255,110,120,.95)", 17);
  } else if (timing > 0.82) {
    say(lx, ly, "PERFECT", "rgba(160,255,190,1)", 24);
    score += Math.round(100 * mult);
  } else {
    const word = delta < 0 ? "early" : "late";
    const col = timing > 0.5 ? "rgba(255,235,150,.95)" : "rgba(255,190,120,.95)";
    say(lx, ly, `${word} ${(off * 1000) | 0}ms`, col, 17);
    score += Math.round(timing * 100 * mult);
  }

  flourish = heat();

  leap(i, right ? 0.35 + flourish : 0.2, right && timing > 0.3);
}

function column(x: number) {
  return Math.min(COUNT - 1, Math.max(0, Math.round(x / slot) - 1));
}

// Two taps to restart. Losing a long run to a misplaced thumb would be far worse
// than the small friction of confirming.
function shareRun() {
  copyLink(runUrl(), H * 0.44);
}

function pokeRestart() {
  const now = ac ? ac.currentTime : 0;
  if (restartArm > 0 && now < restartArm) startRun();
  else restartArm = now + 2.5;
}

canvas.addEventListener("pointerdown", (e: PointerEvent) => {
  e.preventDefault();
  const x = e.clientX;
  const y = e.clientY;

  // If the clock is parked (iOS suspends it on app switch or lock), the first tap
  // does nothing but wake it. Without this the overlay was a label with no behaviour.
  if (ac && ac.state !== "running") {
    ensureAudio();
    return;
  }

  if (phase === COMPOSE) {
    if (inRect(x, y, hearBtn)) previewPattern(ac.currentTime);
    else if (inRect(x, y, clearBtn)) {
      seq = [];
      offs = [];
      compAt = -1;
      pending.length = 0;
    } else if (inRect(x, y, sendBtn)) sendPattern();
    else if (inRect(x, y, backBtn)) {
      seq = [];
      offs = [];
      phase = TITLE;
    } else composeTap(column(x));
    return;
  }

  if (phase === TITLE) {
    if (inRect(x, y, makeBtn)) {
      enterCompose();
      return;
    }
    if (inRect(x, y, playBtn)) {
      if (sharedIn && taps.length) startReplay((ensureAudio(), ac.currentTime));
      else if (sharedIn) startChallenge();
      else startRun();
    } else freePlay(column(x));
    return;
  }

  if (phase === REPLAY) return; // let it play out

  if (inRect(x, y, restartBtn)) {
    pokeRestart();
    return;
  }
  if (inRect(x, y, shareBtn)) {
    shareRun();
    return;
  }
  restartArm = -1; // any tap elsewhere withdraws the offer

  if (phase === GRADE) {
    // Guard against the last note of a phrase bleeding into the choice screen.
    const now = ac.currentTime;
    if (now < phaseAt + 0.4) return;
    if (inRect(x, y, againBtn)) newRound(now, false);
    else if (grew && inRect(x, y, nextBtn)) newRound(now, true);
    else if (inRect(x, y, replayBtn)) startReplay(now);
    else if (inRect(x, y, blindBtn)) retryBlind(now);
    return;
  }

  tap(column(x));
});

addEventListener("keydown", (e: KeyboardEvent) => {
  const i = "12345".indexOf(e.key);
  if (phase === TITLE) {
    if (i >= 0) freePlay(i);
    else if (e.key === " " || e.key === "Enter") startRun();
    return;
  }
  if (phase === GRADE) {
    const now = ac.currentTime;
    if (now < phaseAt + 0.4) return;
    if (e.key === "Enter" || e.key === " ") newRound(now, grew);
    else if (e.key.toLowerCase() === "a") newRound(now, false);
    else if (e.key.toLowerCase() === "r") pokeRestart();
    return;
  }
  if (i >= 0) tap(i);
  else if (e.key.toLowerCase() === "r") pokeRestart();
});

// --- phase machine -------------------------------------------------------

function update(now: number) {
  while (pending.length && pending[0].at <= now) {
    const q = pending.shift();
    if (q.x === undefined) leap(q.i, q.power);
    else launch(q.x, q.hue, q.power, Math.random() < 0.5 ? -1 : 1);
  }

  if (phase === CALL) {
    // Audio runs ahead of the picture: schedule notes up to 120ms early so they
    // land exactly on the beat, and let the visuals catch up in their own frame.
    while (schedIdx < seq.length) {
      const at = phaseAt + offs[schedIdx] * BEAT;
      if (at > now + 0.12) break;
      note(NOTES[seq[schedIdx]], herd[seq[schedIdx]].voice, at, 0.24);
      schedIdx++;
    }
    while (visIdx < seq.length && now >= phaseAt + offs[visIdx] * BEAT) {
      leap(seq[visIdx], 0.45 + flourish * 0.55);
      visIdx++;
    }

    // A rising two-note pickup on the beat before your turn, scheduled on the audio
    // clock like everything else. The handover was the thing that felt ambiguous.
    if (!cued && now > respondStart() - BEAT * 1.1) {
      cued = true;
      note(NOTES[0] * 2, "sine", respondStart() - BEAT * 0.5, 0.13);
      note(NOTES[2] * 2, "sine", respondStart() - BEAT * 0.25, 0.15);
    }

    if (now >= respondStart() - BEAT * 0.5) {
      phase = RESPOND;
      message = "";
      goAt = now;
    }
  } else if (phase === RESPOND) {
    // Wait indefinitely for the first note. Timing out a player who simply hasn't
    // started yet grades a round they never attempted, and there's nothing to gain
    // by cutting them off -- the clock doesn't begin until they tap anyway. The
    // metronome keeps running so the tempo is alive whenever they do start.
    const endAt = turnAt < 0 ? Infinity : turnAt + phraseBeats() * BEAT + windowFor();
    if (now > endAt) {
      let sum = 0;
      for (let i = 0; i < seq.length; i++) {
        sum += Math.max(0, judged[i]);
        // Name the notes that never got played -- silence is the least readable failure.
        if (judged[i] < 0) say(herd[seq[i]].homeX, groundY - 44, "missed", "rgba(255,110,120,.85)", 15);
      }
      accuracy = sum / seq.length;
      phase = GRADE;
      phaseAt = now;

      celebrate(accuracy, now);
      flourish = accuracy; // let the sky settle to match the verdict

      if (accuracy > 0.98) {
        message = "PERFECT";
      } else if (accuracy >= 0.5) {
        message = PASS[round % PASS.length];
      } else {
        message = FAIL[round % FAIL.length];
      }
      grew = accuracy >= 0.5; // below half, the phrase must be repeated
      if (grew) {
        if (seq.length > best) best = seq.length;
        if (!retries && seq.length > bestClean) bestClean = seq.length;
      }
      if (score > bestScore) bestScore = score;
      saveBest();
    }
  }

  if (phase === REPLAY && now > replayEnd) {
    phase = GRADE;
    phaseAt = now;
  }

  // Metronome runs through the call and the response, but not while waiting.
  if (phase === CALL || phase === RESPOND || phase === COMPOSE) {
    for (;;) {
      const at = pulseAt + clickIdx * BEAT;
      if (at > now + 0.12) break;
      if (at >= ac.currentTime - 0.05) click(at, clickIdx % 4 === 0);
      clickIdx++;
    }
  }
}

// --- render --------------------------------------------------------------

function poly(p: number[]) {
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
  ctx.closePath();
}

function drawUnicorn(x: number, y: number, hue: number, vx: number, vy: number, glow: number, gait: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.atan2(vy, vx));
  ctx.scale(SIZE, vx < 0 ? -SIZE : SIZE);

  // Soft halo rather than a flat translucent disc -- a hard-edged circle reads as
  // a bubble around the unicorn instead of light coming off it.
  if (glow > 0.01) {
    const r = 20 + glow * 10;
    const g = ctx.createRadialGradient(0, 0, 2, 0, 0, r);
    g.addColorStop(0, `hsla(${hue},100%,75%,${glow * 0.42})`);
    g.addColorStop(1, `hsla(${hue},100%,70%,0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, 6.284);
    ctx.fill();
  }

  // Angular, faceted build: flat planes and hard corners instead of ellipses. Two
  // tones per mass -- a lit plane and a shadowed one -- so the silhouette reads as
  // folded panels rather than a blob.
  const lit = `hsl(${hue},72%,${66 + glow * 12}%)`;
  const dim = `hsl(${hue},64%,${50 + glow * 10}%)`;
  const pale = `hsl(${hue},76%,${74 + glow * 10}%)`;

  // legs -- straight segments with a hard knee
  ctx.strokeStyle = dim;
  ctx.lineWidth = 3;
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";
  // Each leg sits a quarter-cycle behind the one before it, and every unicorn carries
  // its own phase, so the five read as one herd caught mid-stride rather than five
  // copies of the same drawing.
  const legs = [7, 4, 3, 5, -9, 4, -5, 5];
  for (let j = 0; j < 4; j++) {
    const hx = legs[j * 2];
    const hy = legs[j * 2 + 1];
    const a = gait + j * 1.7;
    const swing = Math.sin(a) * 5.5; // hoof travels fore and aft
    const lift = Math.max(0, Math.cos(a)) * 3.2; // and picks up on the forward reach
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(hx + swing * 0.4 + 1.4, hy + 7 - lift * 0.45);
    ctx.lineTo(hx + swing, hy + 12 - lift);
    ctx.stroke();
  }

  // tail -- a zigzag streak, no curves
  ctx.strokeStyle = pale;
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  const sway = Math.sin(gait) * 2.2;
  ctx.moveTo(-13, -2);
  ctx.lineTo(-19, -7 + sway);
  ctx.lineTo(-23, -1 - sway);
  ctx.lineTo(-20, 4 + sway);
  ctx.lineTo(-25, 8 - sway * 0.5);
  ctx.stroke();

  poly([-14, 0, -9, -8, 1, -9, 9, -5, 10, 4, -2, 6, -11, 5]); // barrel
  ctx.fillStyle = lit;
  ctx.fill();
  poly([-11, 5, -2, 6, 10, 4, 9, 0, -6, 2]); // underside facet
  ctx.fillStyle = dim;
  ctx.fill();

  poly([4, -7, 10, -18, 15, -17, 9, -4]); // neck
  ctx.fillStyle = lit;
  ctx.fill();

  poly([10, -18, 22, -15, 17, -8, 9, -11]); // wedge head
  ctx.fillStyle = pale;
  ctx.fill();

  poly([10.2, -16.6, 9.2, -24.5, 13.6, -15.8]); // ear, rooted on the skull line
  ctx.fillStyle = dim;
  ctx.fill();

  // Horn base straddles the skull line and sits just inside it, so it grows out of
  // the head instead of hovering over it.
  poly([12.4, -16.3, 23, -33.5, 18.4, -14.9]);
  ctx.fillStyle = "#ffd75e";
  ctx.fill();
  poly([17.6, -15.2, 23, -33.5, 18.4, -14.9]); // shadowed side
  ctx.fillStyle = "#e0ac2b";
  ctx.fill();

  // mane -- chevrons up the neck, pointing back
  for (let i = 0; i < 4; i++) {
    poly([3 + i * 2.6, -7 - i * 2.9, 9 + i * 2, -12 - i * 2.6, -1 + i * 2.6, -11 - i * 2.9]);
    ctx.fillStyle = `hsl(${hue + i * 8 - 12},94%,${78 - i * 5}%)`;
    ctx.fill();
  }

  poly([16, -15, 18, -13.5, 16, -12, 14.4, -13.5]); // eye, a diamond
  ctx.fillStyle = "#2e2340";
  ctx.fill();

  ctx.restore();
}

// Big numeral plus a ring that closes over the beat, so the count is readable
// whether you are watching the number or the motion.
function countdown(label: string, beatsLeft: number) {
  const n = Math.max(1, Math.ceil(beatsLeft));
  const frac = 1 - (beatsLeft - Math.floor(beatsLeft)); // 0..1 through this beat
  text(label, W / 2, H * 0.2, 20, 0.5);
  text(`${n}`, W / 2, H * 0.2 + 76, 54, 0.85);
  ctx.strokeStyle = `rgba(255,255,255,${0.5 - frac * 0.35})`;
  ctx.lineWidth = 3;
  ctx.beginPath();
  // Sits clear of the label -- at radius 44 centred higher, the ring cut the text.
  ctx.arc(W / 2, H * 0.2 + 58, 42, -1.5708, -1.5708 + 6.284 * (1 - frac));
  ctx.stroke();
}

// Scales text down until it fits the width given. A fixed size that suits a tablet
// runs off the edge of a phone.
function fitText(s: string, x: number, y: number, maxW: number, cap: number, alpha: number) {
  ctx.font = `800 100px system-ui,-apple-system,sans-serif`;
  const size = Math.min(cap, (maxW / ctx.measureText(s).width) * 100);
  ctx.fillStyle = `rgba(255,255,255,${alpha})`;
  ctx.font = `800 ${size}px system-ui,-apple-system,sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(s, x, y);
  return size;
}

// A labelled button with a quiet second line. Primary gets the brighter treatment.
function choice(
  r: { x: number; y: number; w: number; h: number },
  label: string,
  sub: string,
  primary: boolean,
  locked?: boolean
) {
  btn(r, label, sub, locked ? LOCKED : primary ? GOLD : PLAIN);
}

// Cut corners, not rounded ones -- the herd is faceted, so the furniture should be.
function chamfer(x: number, y: number, w: number, h: number, c: number) {
  ctx.beginPath();
  ctx.moveTo(x + c, y);
  ctx.lineTo(x + w - c, y);
  ctx.lineTo(x + w, y + c);
  ctx.lineTo(x + w, y + h - c);
  ctx.lineTo(x + w - c, y + h);
  ctx.lineTo(x + c, y + h);
  ctx.lineTo(x, y + h - c);
  ctx.lineTo(x, y + c);
  ctx.closePath();
}

const PLAIN = 0;
const GOLD = 1; // the primary action, in horn gold
const LOCKED = 2;
const QUIET = 3;

function spaced(s: string, x: number, y: number, size: number, col: string, weight: number) {
  ctx.letterSpacing = `${Math.max(1, size * 0.09)}px`;
  ctx.fillStyle = col;
  ctx.font = `${weight} ${size}px system-ui,-apple-system,sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(s, x, y);
  ctx.letterSpacing = "0px";
}

// One button, drawn everywhere. A hard un-blurred shadow reads as a printed slab
// rather than a soft web widget.
function btn(
  r: { x: number; y: number; w: number; h: number },
  label: string,
  sub?: string,
  tone: number = PLAIN
) {
  const c = Math.min(13, r.h * 0.3);
  const off = tone === QUIET ? 2 : 4;

  chamfer(r.x + off, r.y + off, r.w, r.h, c);
  ctx.fillStyle = tone === LOCKED ? "rgba(6,4,16,.25)" : "rgba(6,4,16,.6)";
  ctx.fill();

  chamfer(r.x, r.y, r.w, r.h, c);
  ctx.fillStyle =
    tone === GOLD
      ? "#ffd75e"
      : tone === LOCKED
      ? "rgba(255,255,255,.03)"
      : tone === QUIET
      ? "rgba(255,255,255,.06)"
      : "rgba(255,255,255,.09)";
  ctx.fill();
  ctx.lineWidth = tone === QUIET ? 1.6 : 2.6;
  ctx.strokeStyle =
    tone === GOLD
      ? "#fff1bd"
      : tone === LOCKED
      ? "rgba(255,255,255,.12)"
      : tone === QUIET
      ? "rgba(255,255,255,.3)"
      : "rgba(255,255,255,.62)";
  ctx.stroke();

  const fg =
    tone === GOLD ? "#33254a" : tone === LOCKED ? "rgba(255,255,255,.3)" : "rgba(255,255,255,.95)";
  const size = Math.min(sub ? 16 : 18, r.w / (label.length * 0.72 + 2));
  spaced(label, r.x + r.w / 2, r.y + (sub ? r.h * 0.46 : r.h * 0.63), size, fg, 800);
  if (sub)
    spaced(
      sub,
      r.x + r.w / 2,
      r.y + r.h * 0.76,
      Math.min(11.5, r.w / 13),
      tone === GOLD ? "rgba(51,37,74,.62)" : "rgba(255,255,255,.42)",
      600
    );
}

function rrect(x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Shared by the dot row and the compact bar so the two can never disagree.
function slotColor(i: number, cursor: number) {
  if (phase === CALL) return i < visIdx ? `hsl(${HUES[seq[i]]},80%,66%)` : "rgba(255,255,255,.16)";
  if (judged[i] >= 0)
    return judged[i] > 0.55
      ? "rgba(150,255,180,.95)"
      : judged[i] > 0
      ? "rgba(255,225,120,.9)"
      : "rgba(255,110,120,.85)";
  return i === cursor ? "rgba(255,255,255,.7)" : "rgba(255,255,255,.16)";
}

function text(s: string, x: number, y: number, size: number, alpha: number) {
  ctx.fillStyle = `rgba(255,255,255,${alpha})`;
  ctx.font = `600 ${size}px system-ui,-apple-system,sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(s, x, y);
}

let last = 0;
function frame(nowMs: number) {
  requestAnimationFrame(frame);
  const dt = Math.min((nowMs - last) / 1000, 0.05);
  last = nowMs;
  const now = ac ? ac.currentTime : 0;

  if (ac) update(now);
  if (phase === COMPOSE && compAt > 0) pulseAt = compAt;

  // Dusk sky rather than the flat purple: deep overhead, warming toward the horizon,
  // and still dark enough that the additive ribbons and fireworks read against it.
  const lift = phase === TITLE ? 0 : flourish;
  const sky = ctx.createLinearGradient(0, 0, 0, groundY);
  sky.addColorStop(0, `hsl(230,58%,${9 + lift * 7}%)`);
  sky.addColorStop(0.55, `hsl(216,52%,${19 + lift * 10}%)`);
  sky.addColorStop(1, `hsl(198,48%,${31 + lift * 13}%)`);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  for (const c of clouds) {
    c.x -= c.v * dt;
    if (c.x < -160 * c.s) c.x = W + 160 * c.s;
    drawCloud(c, lift);
  }

  // Storm cadence: ~3-8s apart when you're struggling, ~1-2.5s at full flourish.
  const weather = phase === TITLE ? 0.12 : flourish;
  boltTimer -= dt;
  if (boltTimer <= 0) {
    strike(0.2 + weather * 0.8);
    boltTimer = (5.5 - weather * 3.8) * (0.55 + Math.random() * 0.9);
  }

  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = bolts.length - 1; i >= 0; i--) {
    const b = bolts[i];
    b.age += dt;
    if (b.age > b.life) {
      bolts.splice(i, 1);
      continue;
    }
    // Flicker rather than a smooth fade -- lightning stutters.
    const a = (1 - b.age / b.life) * (0.55 + 0.45 * Math.sin(b.age * 90));
    ctx.beginPath();
    ctx.moveTo(b.pts[0], b.pts[1]);
    for (let p = 2; p < b.pts.length; p += 2) ctx.lineTo(b.pts[p], b.pts[p + 1]);
    ctx.strokeStyle = `rgba(150,205,255,${a * 0.3 * b.power})`;
    ctx.lineWidth = 11 * b.power + 2;
    ctx.stroke();
    ctx.strokeStyle = `rgba(255,255,255,${a * 0.9})`;
    ctx.lineWidth = 2.4;
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";

  // Rainbows sit behind the whole scene: sky first, arcs, then everything else.
  for (let i = bows.length - 1; i >= 0; i--) {
    const b = bows[i];
    b.age += dt;
    if (b.age > b.life) {
      bows.splice(i, 1);
      continue;
    }
    const a = Math.sin((b.age / b.life) * 3.1416) * 0.3; // fade in and back out
    const bandW = b.r * 0.055;
    ctx.lineWidth = bandW;
    for (let k = 0; k < 7; k++) {
      ctx.strokeStyle = `hsla(${BANDS[k]},92%,62%,${a})`;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r - k * bandW, 3.1416, 6.2832);
      ctx.stroke();
    }
  }

  // --- flyers ---
  for (let i = flyers.length - 1; i >= 0; i--) {
    const f = flyers[i];
    f.vy += G * dt;
    f.x += f.vx * dt;
    f.y += f.vy * dt;

    // Walls keep a bounced copy in play; the floor is the exit.
    if (f.x < 24) (f.x = 24), (f.vx = Math.abs(f.vx) * BOUNCE);
    else if (f.x > W - 24) (f.x = W - 24), (f.vx = -Math.abs(f.vx) * BOUNCE);
    if (f.y < 26) (f.y = 26), (f.vy = Math.abs(f.vy) * BOUNCE);

    f.ribbon.pts.push(f.x, f.y + 4);
    if (f.y > H + 60) flyers.splice(i, 1); // fell through the floor
  }

  // midair collisions between copies
  for (let i = 0; i < flyers.length; i++) {
    for (let j = i + 1; j < flyers.length; j++) {
      const a = flyers[i];
      const b = flyers[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 0.001;
      if (d > HIT) continue;
      const nx = dx / d;
      const ny = dy / d;
      const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (vn > 0) continue; // already separating
      const imp = -(1 + BOUNCE) * vn * 0.5;
      a.vx -= imp * nx;
      a.vy -= imp * ny;
      b.vx += imp * nx;
      b.vy += imp * ny;
      const push = (HIT - d) * 0.5;
      a.x -= nx * push;
      a.y -= ny * push;
      b.x += nx * push;
      b.y += ny * push;

      // Two well-played notes crossing midair is worth something. Accuracy already
      // makes arcs bigger, so playing well produces more crossings on its own --
      // the reward loop closes without asking the player to aim at anything.
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const bonus = a.hot && b.hot;
      burst(mx, my, a.idx, b.idx, bonus ? 1 : 0.3 + flourish);
      if (bonus) {
        const pts = Math.round(250 * mult);
        score += pts;
        combo++;
        a.hot = b.hot = false; // one payout per pair
        say(mx, my - 20, `+${pts}`, "rgba(255,240,160,1)", 26);
      }
    }
  }

  // ribbons + fireworks, additive
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = ribbons.length - 1; i >= 0; i--) {
    const r = ribbons[i];
    r.age += dt;
    if (r.age > 2.2) {
      ribbons.splice(i, 1);
      continue;
    }
    if (r.pts.length < 4) continue;
    const a = 1 - r.age / 2.2;
    ctx.beginPath();
    ctx.moveTo(r.pts[0], r.pts[1]);
    for (let p = 2; p < r.pts.length; p += 2) ctx.lineTo(r.pts[p], r.pts[p + 1]);
    ctx.strokeStyle = `hsla(${r.hue},95%,60%,${a * 0.28})`;
    ctx.lineWidth = (16 * a + 3) * r.fat;
    ctx.stroke();
    ctx.strokeStyle = `hsla(${r.hue},100%,78%,${a * 0.75})`;
    ctx.lineWidth = (5 * a + 1) * r.fat;
    ctx.stroke();
  }

  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i];
    f.age += dt;
    if (f.age > 0.34) {
      flashes.splice(i, 1);
      continue;
    }
    const k = f.age / 0.34;
    ctx.strokeStyle = `rgba(255,255,255,${(1 - k) * 0.7})`;
    ctx.lineWidth = 9 * (1 - k) + 1;
    ctx.beginPath();
    ctx.arc(f.x, f.y, 12 + k * f.r, 0, 6.284);
    ctx.stroke();
  }

  for (let i = sparks.length - 1; i >= 0; i--) {
    const p = sparks[i];
    p.age += dt;
    if (p.age > p.life) {
      sparks.splice(i, 1);
      continue;
    }
    p.vy += 300 * dt;
    p.vx *= 1 - 1.6 * dt;
    p.vy *= 1 - 1.6 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const a = 1 - p.age / p.life;
    ctx.fillStyle = p.white ? `rgba(255,255,255,${a * 0.9})` : `hsla(${p.hue},100%,68%,${a * 0.85})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, a * 3.5 + 0.6, 0, 6.284);
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";

  // Ground brightens on every beat -- a visible pulse to play against, so the
  // rhythm isn't carried by the click alone.
  let pulse = 0;
  if (ac && (phase === CALL || phase === RESPOND)) {
    const ph = ((now - pulseAt) / BEAT) % 1;
    pulse = Math.max(0, 1 - (ph < 0 ? ph + 1 : ph) * 3);
  }
  // Dark land against the bright horizon, so the herd is silhouetted rather than
  // dissolving into a pale band.
  ctx.fillStyle = `hsl(208,36%,${13 + lift * 5 + pulse * 6}%)`;
  ctx.fillRect(0, groundY + 16, W, H);
  ctx.fillStyle = `rgba(150,220,255,${0.18 + pulse * 0.5})`;
  ctx.fillRect(0, groundY + 16, W, 2);

  for (const f of flyers) drawUnicorn(f.x, f.y - 14, f.hue, f.vx, f.vy, f.glow, f.gait);

  if (flashA > 0.002) {
    ctx.fillStyle = `rgba(196,224,255,${flashA * 0.45})`;
    ctx.fillRect(0, 0, W, H);
    flashA -= dt * 2.6;
  }

  for (const u of herd) {
    u.lit = Math.max(0, u.lit - dt * 1.6);
    u.bob += dt * 2.2;
    drawUnicorn(u.homeX, groundY - 14 - Math.abs(Math.sin(u.bob)) * 3, u.hue, 1, 0, u.lit, u.gait);
  }

  // --- hud ---
  if (phase === TITLE) {
    fitText("UNICORN STORM", W / 2, H * 0.24, W * 0.84, 68, 0.96);
    text("the herd plays a phrase. play it back.", W / 2, H * 0.24 + 42, Math.min(19, W / 26), 0.55);

    // One obvious target. It breathes so it reads as the live thing on screen.
    btn(playBtn, sharedIn ? (taps.length ? "WATCH REPLAY" : "TRY THIS") : "PLAY", undefined, GOLD);
    if (sharedIn)
      text("someone sent you this", W / 2, playBtn.y - 16, Math.min(15, W / 34), 0.45);

    // The herd is live here: hearing the five voices before being graded on them
    // is the cheapest tutorial there is.
    btn(makeBtn, "MAKE A PATTERN");

    if (best) {
      text(
        `best ${best} notes  ·  ${bestScore} pts`,
        W / 2,
        makeBtn.y + makeBtn.h + 30,
        Math.min(16, W / 33),
        0.5
      );
      if (bestClean)
        text(
          `${bestClean} notes with no retries`,
          W / 2,
          makeBtn.y + makeBtn.h + 52,
          Math.min(14, W / 38),
          0.35
        );
    }

    // Demoted to small print. As a shout it out-competed the actual call to action.
    text("turn on yer sound", W / 2, H - 20, Math.min(16, W / 30), 0.42);
    return;
  }

  if (phase === COMPOSE) {
    text("make a pattern", W / 2, H * 0.16, 24, 0.85);
    text(
      seq.length ? `${seq.length} note${seq.length > 1 ? "s" : ""} — tap the herd to add` : "tap the herd to lay down notes",
      W / 2,
      H * 0.16 + 28,
      15,
      0.45
    );
    text("notes snap to the nearest half beat", W / 2, H * 0.16 + 50, 13, 0.3);

    // the pattern so far, spaced by time
    if (seq.length) {
      const beats = Math.max(1, offs[offs.length - 1]);
      const span = Math.min(W - 96, Math.max(120, 30 * beats));
      const x0 = W / 2 - span / 2;
      for (let i = 0; i < seq.length; i++) {
        ctx.beginPath();
        ctx.arc(x0 + (offs[i] / beats) * span, H * 0.16 + 84, 6, 0, 6.284);
        ctx.fillStyle = `hsl(${HUES[seq[i]]},80%,66%)`;
        ctx.fill();
      }
    }

    const on = seq.length >= 2;
    // Notes you lay down keep flying through this row, so give the controls a bed.
    rrect(hearBtn.x - 12, hearBtn.y - 10, backBtn.x + backBtn.w - hearBtn.x + 24, hearBtn.h + 20, 30);
    ctx.fillStyle = "rgba(12,9,28,.66)";
    ctx.fill();

    for (const [r, label, live] of [
      [hearBtn, "HEAR", seq.length > 0],
      [clearBtn, "CLEAR", seq.length > 0],
      [sendBtn, "COPY LINK", on],
      [backBtn, "BACK", true],
    ] as [typeof clearBtn, string, boolean][]) {
      btn(r, label, undefined, live ? (label === "COPY LINK" ? GOLD : PLAIN) : LOCKED);
    }
    if (!on) text("at least two notes to send", W / 2, hearBtn.y + 66, 12, 0.3);
    return;
  }

  // Sequence dots: one per note, so you can see how long the phrase is and,
  // during your turn, which beat you're on.
  const n = seq.length;
  const dotY = 42 + topPad;
  let cursor = -1;
  if (phase === RESPOND) {
    cursor = 0;
    if (turnAt >= 0) {
      let d = 1e9;
      for (let j = 0; j < seq.length; j++) {
        const t = Math.abs(now - (turnAt + offs[j] * BEAT));
        if (judged[j] < 0 && t < d) {
          d = t;
          cursor = j;
        }
      }
    }
  }

  // Dots are laid out by TIME, not by index: a half-beat pair sits tight together
  // and a two-beat gap opens up. The row becomes readable notation of the rhythm.
  const beats = Math.max(1, phraseBeats());
  if (n <= 16) {
    const span = Math.min(W - 96, 30 * beats);
    const r = Math.min(5.5, Math.max(2.6, (span / beats) * 0.16));
    const x0 = W / 2 - span / 2;
    for (let i = 0; i < n; i++) {
      ctx.beginPath();
      ctx.arc(x0 + (offs[i] / beats) * span, dotY, i === cursor ? r + 2.5 : r, 0, 6.284);
      ctx.fillStyle = slotColor(i, cursor);
      ctx.fill();
    }
  } else {
    // Past ~16 the dots are too small to count, so switch to a segmented bar plus a
    // "7 / 24" readout: you stop counting pips and start reading a position.
    const bw = Math.min(W - 76, 470);
    const bx = (W - bw) / 2;
    for (let i = 0; i < n; i++) {
      const gap = i + 1 < n ? offs[i + 1] - offs[i] : 1;
      ctx.fillStyle = slotColor(i, cursor);
      ctx.fillRect(
        bx + (offs[i] / beats) * bw,
        dotY - (i === cursor ? 9 : 5),
        Math.max(1.5, (gap / beats) * bw - 1.2),
        i === cursor ? 18 : 10
      );
    }
    text(`${Math.min(Math.max(cursor + 1, 1), n)} / ${n}`, W / 2, dotY + 26, 12, 0.45);
  }

  // Floating judgements
  for (let i = labels.length - 1; i >= 0; i--) {
    const l = labels[i];
    l.age += dt;
    if (l.age > 1.1) {
      labels.splice(i, 1);
      continue;
    }
    const a = 1 - l.age / 1.1;
    ctx.globalAlpha = Math.min(1, a * 1.6);
    ctx.fillStyle = l.col;
    ctx.font = `700 ${l.size}px system-ui,-apple-system,sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(l.s, l.x, l.y - (1 - a) * 42);
    ctx.globalAlpha = 1;
  }

  if (phase === CALL) {
    const toCall = (phaseAt - now) / BEAT;
    const toTurn = (respondStart() - now) / BEAT;
    if (toCall > 0) {
      // Countdown to the herd playing. Previously the first note just arrived.
      countdown("the herd plays in", toCall);
    } else if (REST > 1 && visIdx >= seq.length && toTurn <= REST) {
      countdown("your turn in", toTurn);
    } else {
      text("listen", W / 2, H * 0.2, 22, 0.5);
    }
  } else if (phase === REPLAY) {
    const turnStarts = replayEnd - 1.4 - (taps.length ? taps[taps.length - 1].dt : 0);
    text("instant replay", W / 2, H * 0.2, 22, 0.6);
    text(now < turnStarts ? "the phrase" : "your take", W / 2, H * 0.2 + 26, 15, 0.42);
  } else if (phase === RESPOND) {
    // "GO" punches in and fades, so the switch reads instantly.
    const since = now - goAt;
    if (since < 0.7) {
      const k = since / 0.7;
      text("GO", W / 2, H * 0.2 + 6, 34 + (1 - k) * 26, 0.95 * (1 - k));
    } else if (turnAt < 0) {
      // Say plainly that the clock is waiting on them.
      text("your turn", W / 2, H * 0.2, 22, 0.6);
      text("the beat starts on your first note", W / 2, H * 0.2 + 26, 15, 0.4);
    } else {
      text("your turn", W / 2, H * 0.2, 22, 0.6);
    }
  } else {
    const big = message === "PERFECT";
    // Scrim: at high scores the celebration is bright enough to swallow the UI.
    const pw = Math.min(W - 32, 520);
    const py = H * 0.2 - 42;
    rrect((W - pw) / 2, py, pw, replayBtn.y + replayBtn.h + 16 - py, 26);
    ctx.fillStyle = "rgba(12,9,28,.62)";
    ctx.fill();

    text(message, W / 2, H * 0.2, big ? 46 : 28, big ? 0.95 : 0.8);
    if (!big) text(`${(accuracy * 100) | 0}% match`, W / 2, H * 0.2 + 34, 18, 0.55);
    if (combo) text(`${combo} midair bonus`, W / 2, H * 0.2 + 56, 15, 0.5);

    // Two real options. Whichever suits the result is highlighted, but both are
    // always available -- replaying a phrase you nailed is a legitimate choice,
    // and so is pressing on after a scrappy one.
    choice(againBtn, "HEAR IT AGAIN", "same phrase", !grew);
    if (grew) choice(nextBtn, "NEXT", "one note longer", true);
    else choice(nextBtn, "NEXT", "needs 50%", false, true);

    btn(blindBtn, "NO PREVIEW", undefined, QUIET);
    btn(replayBtn, "REPLAY", undefined, QUIET);
  }

  if (round <= 1 && phase === CALL && now - (phaseAt - BEAT * LEADIN) < 6) {
    text("sound on?", W / 2, H - 44, 15, 0.4);
  }

  {
    const armed = restartArm > 0 && now < restartArm;
    btn(restartBtn, armed ? "SURE?" : "RESTART", undefined, armed ? GOLD : QUIET);
    btn(shareBtn, "COPY", undefined, QUIET);
  }

  if (ac.state !== "running") {
    ctx.fillStyle = "rgba(10,8,24,.72)";
    ctx.fillRect(0, 0, W, H);
    text("paused", W / 2, H * 0.46, 30, 0.9);
    text("tap anywhere to resume", W / 2, H * 0.46 + 30, 18, 0.6);
    // Surfaced deliberately: if a tap still won't clear this, the state name says why.
    text(`audio: ${ac.state}`, W / 2, H * 0.46 + 56, 13, 0.35);
  }

  text(`${score}`, W / 2, 98 + topPad, 22, 0.7);
  text(
    `${seq.length} notes   ${mult > 1 ? `x${mult.toFixed(1)}   ` : ""}longest ${best}`,
    W / 2,
    H - 18,
    14,
    0.35
  );
}

loadBest();

// A link like #40213.111.40012a... carries a whole round: the pattern, and optionally
// the attempt. With taps it is a replay to watch; without them it is a challenge.
if (location.hash.length > 3 && decodeRun(location.hash.slice(1))) sharedIn = true;

resize();
requestAnimationFrame(frame);
