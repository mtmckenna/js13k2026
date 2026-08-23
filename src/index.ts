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

// Pure logic lives in core.js so node --test can assert on it directly. Nothing in
// here may re-implement any of it -- a second copy is a copy that drifts.
import {
  BEAT,
  BPM,
  HIGH_F,
  HOLD_HIGH,
  WINDOW,
  accuracyOf,
  decodeRun as coreDecode,
  encodeJam,
  encodeRun as coreEncode,
  flightFor,
  heat as coreHeat,
  judgeSlot,
  launchParams,
  NOTE_POWER,
  tierFor,
  timingScore,
  SONGS,
  songAt,
  multFor,
  nextGap as coreGap,
  windowFor as coreWindow,
} from "./core.js";

const NOTES = [261.63, 293.66, 329.63, 392.0, 440.0]; // C D E G A -- major pentatonic
const HUES = [350, 35, 120, 205, 280];
const VOICES = ["triangle", "sine", "triangle", "sine", "triangle"];
const COUNT = NOTES.length;

// Sized from the herd spacing so the whole scene scales together, clamped so phones
// don't end up with ants and wall displays with giants.
let SIZE = 1.55;
let HIT = 59;
const BOUNCE = 0.96;

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
  g: number; // own gravity, so flight time is screen-independent
  armAt: number; // audio time at which a sustained hold becomes a high leap
  holding: boolean;
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
const bolts: { legs: number[][]; age: number; life: number; power: number }[] = [];
let flashA = 0;
let boltTimer = 2;

// One jagged run from (x,y) downward. Used for the trunk and every fork.
function jag(x: number, y: number, drop: number, steps: number, spread: number, bias: number) {
  const pts = [x, y];
  const dy = drop / steps;
  for (let i = 0; i < steps; i++) {
    x += (Math.random() - 0.5) * spread + bias;
    y += dy * (0.65 + Math.random() * 0.7);
    pts.push(x, y);
  }
  return pts;
}

function strike(power: number) {
  const x0 = 40 + Math.random() * (W - 80);
  const trunk = jag(x0, -12, groundY * 0.8, 7 + ((Math.random() * 4) | 0), 95, 0);
  const legs = [trunk];

  // Forks peel off the trunk's joints and run shorter, angled away. A single
  // unbranched line reads as a crack, not a lightning strike.
  const n = 2 + ((Math.random() * 3) | 0);
  for (let f = 0; f < n; f++) {
    const joint = 2 * (1 + ((Math.random() * (trunk.length / 2 - 2)) | 0));
    const bx = trunk[joint];
    const by = trunk[joint + 1];
    const remain = groundY * 0.8 - by;
    if (remain < 40) continue;
    legs.push(
      jag(bx, by, remain * (0.25 + Math.random() * 0.45), 3 + ((Math.random() * 3) | 0), 70, (Math.random() - 0.5) * 46)
    );
  }

  bolts.push({ legs, age: 0, life: 0.3 + Math.random() * 0.22, power });
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

// Faceted, but shaped like a cloud: a flat base with several uneven humps across the
// top. The first attempt had one central peak and long straight flanks, which is the
// silhouette of a mountain -- the facets were never the problem, the profile was.
function drawCloud(c: Cloud, lift: number) {
  const w = 160 * c.s;
  const h = 46 * c.s;
  const j = (c.k - 0.5) * 0.22; // per-cloud lumpiness

  // x, y as fractions of the box; y=0 is the flat underside.
  const top = [
    -0.5, 0, -0.47, -0.2, -0.36, -0.4 - j, -0.24, -0.3, -0.13, -0.56 + j, 0.0, -0.68 - j * 0.6,
    0.13, -0.46, 0.25, -0.57 + j, 0.36, -0.34 - j, 0.47, -0.18, 0.5, 0,
  ];

  ctx.save();
  ctx.translate(c.x, c.y);

  const pts: number[] = [];
  for (let i = 0; i < top.length; i += 2) pts.push(top[i] * w, top[i + 1] * h);
  pts.push(w * 0.5, h * 0.3, -w * 0.5, h * 0.3); // the flat underside
  poly(pts);
  ctx.fillStyle = `hsla(${214 - lift * 26},40%,${64 + lift * 14}%,${c.a * (1 - lift * 0.5)})`;
  ctx.fill();

  // One lit plane across the upper humps, as if the light is above and behind.
  poly([
    -0.36 * w, (-0.4 - j) * h,
    -0.13 * w, (-0.56 + j) * h,
    0.0, (-0.68 - j * 0.6) * h,
    0.25 * w, (-0.57 + j) * h,
    0.13 * w, -0.28 * h,
    -0.18 * w, -0.18 * h,
  ]);
  ctx.fillStyle = `hsla(${203 - lift * 40},58%,${79 + lift * 14}%,${c.a * 0.6 * (1 - lift * 0.55)})`;
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
const jamBtn = { x: 0, y: 0, w: 0, h: 0 };
const beatBtn = { x: 0, y: 0, w: 0, h: 0 };
const hardBtn = { x: 0, y: 0, w: 0, h: 0 };
const copyBtn = { x: 0, y: 0, w: 0, h: 0 };
const homeBtn = { x: 0, y: 0, w: 0, h: 0 };
const goBtn = { x: 0, y: 0, w: 0, h: 0 };
const songBtn = { x: 0, y: 0, w: 0, h: 0 };
const songSlot = { x: 0, y: 0, w: 0, h: 0 };
const hideBtn = { x: 0, y: 0, w: 0, h: 0 };

// One rect reused per row, so the picker costs no extra state.
function songRect(i: number) {
  songSlot.w = Math.min(300, W - 60);
  songSlot.h = 46;
  songSlot.x = (W - songSlot.w) / 2;
  songSlot.y = H * 0.26 + i * 56;
  return songSlot;
} // sits below the briefing, clear of the text
// Set when there is something worth sharing. Copying was a side effect of pressing
// STOP or DONE -- invisible, and impossible to repeat if you lost the clipboard.
let shareUrl = "";
let shareWhat = "";
let copiedAt = -9;

function inRect(x: number, y: number, r: { x: number; y: number; w: number; h: number }) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

// iOS ignores user-scalable=no, so double-tap and pinch still zoom and pan the page.
// These are the events that actually carry it.
for (const ev of ["gesturestart", "gesturechange", "gestureend", "dblclick", "contextmenu", "selectstart"]) {
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
  SIZE = Math.max(1.05, Math.min(1.95, slot * 0.0105));
  // Collision radius in herd-spacing units, floored so it never drops below the
  // drawn body on a narrow phone.
  HIT = Math.max(34, slot * 0.4);
  if (!clouds.length) seedClouds();
  for (let i = 0; i < herd.length; i++) herd[i].homeX = slot * (i + 1);

  playBtn.w = Math.min(260, W * 0.62);
  playBtn.h = 62;
  playBtn.x = (W - playBtn.w) / 2;
  playBtn.y = H * 0.4;

  // Top-left, well clear of the herd: a stray gameplay tap must never restart a run.

  copyBtn.w = Math.min(238, W - 80);
  copyBtn.h = 48;
  copyBtn.x = (W - copyBtn.w) / 2;
  copyBtn.y = H * 0.16 + 96;

  goBtn.w = Math.min(260, W * 0.62);
  goBtn.h = 62;
  goBtn.x = (W - goBtn.w) / 2;
  goBtn.y = H * 0.2 + 196;

  // End-of-round choice, side by side and equally reachable.
  // Stacked, full width, in the order you'd want them: have another go, hear it
  // first, or move on. Side by side they read as unrelated; a column reads as a list.
  const gw = Math.min(352, W - 56);
  const gh = 50;
  const gy = H * 0.2 + 76;
  blindBtn.w = againBtn.w = nextBtn.w = gw;
  blindBtn.h = againBtn.h = nextBtn.h = gh;
  blindBtn.x = againBtn.x = nextBtn.x = W / 2 - gw / 2;
  blindBtn.y = gy;
  againBtn.y = gy + gh + 10;
  nextBtn.y = gy + (gh + 10) * 2;

  const bw4 = Math.min(122, (W - 72) / 4);
  jamBtn.w = makeBtn.w = hardBtn.w = songBtn.w = bw4;
  jamBtn.h = makeBtn.h = hardBtn.h = songBtn.h = 46;
  jamBtn.y = makeBtn.y = hardBtn.y = songBtn.y = playBtn.y + playBtn.h + 68;
  const r0 = W / 2 - (bw4 * 4 + 24) / 2;
  songBtn.x = r0;
  hardBtn.x = r0 + bw4 + 8;
  jamBtn.x = r0 + (bw4 + 8) * 2;
  makeBtn.x = r0 + (bw4 + 8) * 3;

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
const JAM = 6;
const BRIEF = 7;
const PICK = 8;

let phase = TITLE;
let phaseAt = 0; // audio-clock time this phase began
let seq: number[] = [];
// Beat offset of each note from the phrase start. Uniform 1-beat spacing to begin
// with; longer phrases earn held notes and then off-beat pairs.
let offs: number[] = [];
// Hardcore only: 0 = a low hop, 1 = a high leap. Normal phrases are all low, so the
// height channel simply isn't in play there.
let hgt: number[] = [];
let hardcore = false;
let compHard = false; // does the pattern being written use heights?
// A song is a pattern with a fixed order, so it rides the whole challenge path --
// only the growth step differs: take the composer's next note instead of a random one.
let song: { name: string; seq: number[]; offs: number[] } = null;

// Where the hold actually changes anything. Normal play is deliberately one height:
// holding does nothing, so there is exactly one thing to get right.
// One leap shape for herd and player alike. They were on different formulas
// (0.45+f*0.55 against 0.35+f) and the herd got 20% more boost than a player could
// ever produce -- so in hardcore the demo could not be matched even in principle.
// In hardcore the arc carries information, so it is canonical; elsewhere it may
// still swell with flourish.
function notePower() {
  return NOTE_POWER;
}

function heightsLive() {
  return phase === JAM || (phase === COMPOSE && compHard) || (hardcore && phase !== TITLE);
}
// Hardcore has exactly two arcs, so the player's must SNAP to them. Continuous lift
// gave every intermediate height -- a 50ms tap already overshot the herd's low note,
// and no hold reproduced its high one. Both sides now fly the identical path: launch
// low, and if still held at HOLD_HIGH, convert to the one canonical high apex.

function phraseBeats() {
  return offs[offs.length - 1];
}
let round = 0;
let best = 0; // longest phrase reached
let bestScore = 0;
let bestClean = 0; // longest phrase reached without a single retry
// The metronome click and the ground flash are the same idea in two senses, so they
// are one switch rather than two.
let beatOn = true;
// In jam and compose the pulse waits for you: your first note IS beat one, the same
// way the response clock anchors to your first tap. (The scored countdown still
// clicks, because there the point is to hand you a tempo before the herd plays.)
let freeBeat = false;
let streak = 0; // rounds advanced in a row without retrying
let mult = 1;
let retries = 0;

// Persisted across visits. Wrapped: Safari private mode throws on access.
function loadBest() {
  try {
    best = +localStorage.us_l || 0;
    bestScore = +localStorage.us_s || 0;
    bestClean = +localStorage.us_c || 0;
    beatOn = localStorage.us_b !== "0";
  } catch (e) {}
}
function saveBest() {
  try {
    localStorage.us_l = best;
    localStorage.us_s = bestScore;
    localStorage.us_c = bestClean;
    localStorage.us_b = beatOn ? "1" : "0";
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

let sharedJam = false;

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
    mult = multFor(streak);
  }

  if (song && !keep) {
    // Reveal the tune a note at a time; the ramp is the same, the notes are written.
    const n = Math.min(song.seq.length, seq.length ? seq.length + (grow ? 1 : 0) : 2);
    seq = song.seq.slice(0, n);
    offs = song.offs.slice(0, n);
    hgt = seq.map(() => 0);
  } else if (keep) {
    // a pattern arrived from someone else -- play it as given
  } else if (!seq.length) {
    seq = [(Math.random() * COUNT) | 0, (Math.random() * COUNT) | 0];
    offs = [0, 1];
    hgt = hardcore ? [(Math.random() * 2) | 0, (Math.random() * 2) | 0] : [0, 0];
  } else if (grow) {
    seq.push((Math.random() * COUNT) | 0);
    offs.push(phraseBeats() + coreGap(seq.length, Math.random(), hardcore));
    hgt.push(hardcore && Math.random() < 0.45 ? 1 : 0);
  }

  judged = seq.map(() => -1);
  taps = [];
  schedIdx = visIdx = 0;
  clickIdx = round === 0 ? -LEADIN : -LEADIN_NEXT; // click through the countdown to set tempo
  cued = false;
  midRestart = false;
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
    flashA = Math.max(flashA, 0.55); // a blaze, not a bolt
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

function windowFor() {
  return coreWindow(offs);
}

function heat() {
  return coreHeat(judged, seq.length);
}

function encodeRun() {
  return coreEncode({ seq, offs, hgt, taps });
}

function decodeRun(code: string) {
  const r = coreDecode(code);
  if (!r) return false;
  seq = r.seq;
  offs = r.offs;
  hgt = r.hgt;
  taps = r.taps;
  sharedJam = !!r.jam;
  hardcore = !!r.hardcore;
  return true;
}

function respondStart() {
  return phaseAt + (phraseBeats() + REST) * BEAT;
}

// --- leaping -------------------------------------------------------------

// Exaggeration is the reward: arcs swell with `power`, which tracks how well the
// player is doing right now.
// The most recent flyer, so a press can keep hold of what it just launched.
let lastLaunched: Flyer = null;

function launch(x: number, hue: number, power: number, dir: number, hot?: boolean, idx?: number) {
  const { peak, flight, g, vy0, reach } = launchParams(H, slot, power);
  const vy = -vy0;
  if (x + dir * reach < 40 || x + dir * reach > W - 40) dir = -dir;

  const ribbon = { hue, pts: [], age: 0, fat: 0.6 + Math.max(power - 0.5, flourish) };
  ribbons.push(ribbon);
  const f: Flyer = {
    x,
    y: groundY - 6,
    vx: (dir * reach) / flight,
    vy: -vy,
    hue,
    g,
    armAt: 0,
    holding: false,
    // Airborne copies keep a stride too, and a random one for crowd extras.
    gait: idx === undefined ? Math.random() * 6.28 : herd[idx].gait,
    idx: idx === undefined ? HUES.indexOf(hue) : idx,
    glow: 0.3 + Math.max(power - 0.5, flourish) * 0.7,
    hot: !!hot,
    ribbon,
  };
  flyers.push(f);
  lastLaunched = f;
  return f;
}

function leap(i: number, power: number, hot?: boolean) {
  const u = herd[i];
  // Alternate by index so neighbours sweep opposite ways and their arcs can meet.
  const f = launch(u.homeX, u.hue, power, i % 2 ? -1 : 1, hot, i);
  u.lit = 1;
  return f;
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
      // Fan across the arc between the two hues rather than picking one of them, so a
      // burst is a spectrum instead of two tones that average out to white.
      hue: h1 + (((h2 - h1 + 540) % 360) - 180) * (i / n) * 1.15 + (Math.random() - 0.5) * 26,
      age: 0,
      life: 0.7 + Math.random() * 0.8,
      white: i % 17 === 0, // a couple of hot-core sparks, not a seventh of them
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

// Jam mode has no score to drive the spectacle, so the playing drives it instead:
// every note stokes the weather, and it dies down when you stop.
let jamHeat = 0;
let jamRec = false;
let jamRecAt = 0;
let jamTaps: { i: number; dt: number }[] = [];

// A jam is a performance, not a challenge -- there's no phrase to match, so it gets
// its own "j." link that simply plays back what was played.
function playJam(now: number) {
  if (!taps.length) return;
  pending.length = 0;
  const t0 = now + 0.4;
  for (const p of taps) {
    const at = t0 + p.dt;
    note(NOTES[p.i], herd[p.i].voice, at, 0.22);
    pending.push({ at, i: p.i, power: 0.7 });
  }
  replayEnd = t0 + taps[taps.length - 1].dt + 1.4;
  phase = REPLAY;
}

function enterJam() {
  ensureAudio();
  phase = JAM;
  jamHeat = 0;
  flourish = 0;
  message = "";
  freeBeat = false;
}

function enterCompose() {
  ensureAudio();
  seq = [];
  offs = [];
  hgt = [];
  taps = [];
  compAt = -1;
  patternDone = false;
  freeBeat = false;
  phase = COMPOSE;
  phaseAt = ac.currentTime;
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
    freeBeat = true;
    offs.push(0);
  } else {
    let o = Math.round((now - compAt) / (BEAT * 0.5)) * 0.5;
    const last = offs[offs.length - 1];
    if (o <= last) o = last + 0.5;
    offs.push(o);
  }
  seq.push(i);
  hgt.push(0);
  note(NOTES[i], herd[i].voice, now, 0.22);
  leap(i, 0.5);
  lastClaimK = seq.length - 1;
  lastClaimAt = now;
}

// Copies the bare URL and nothing else. Copying a whole sentence means pasting prose
// into a URL bar, and the old code also claimed success on paths where it had copied
// nothing at all.
// A real DOM input holding the link, parked under the copy button. Canvas text can't
// be selected, and both clipboard APIs can silently no-op on iOS while reporting
// success -- so the guaranteed path is showing you the URL to long-press yourself.
const linkEl = document.createElement("input");
linkEl.readOnly = true;
linkEl.style.cssText =
  "position:fixed;display:none;box-sizing:border-box;font:600 13px system-ui,-apple-system,sans-serif;" +
  "padding:9px;border-radius:10px;border:1px solid rgba(255,255,255,.32);background:rgba(10,8,26,.92);" +
  "color:#fff;text-align:center;-webkit-user-select:text;user-select:text;-webkit-touch-callout:default";
document.body.appendChild(linkEl);
linkEl.addEventListener("focus", () => linkEl.select());
linkEl.addEventListener("click", () => linkEl.select());

let linkShown = false;
// Where the selectable link sits: under the copy panel in jam and compose, and in
// the gap between the round-end panel and the herd during play.
function linkTop() {
  return phase === JAM || phase === COMPOSE
    ? copyBtn.y + copyBtn.h + 34
    : nextBtn.y + nextBtn.h + 30;
}

function showLink(on: boolean) {
  if (on === linkShown && (!on || linkEl.value === shareUrl)) return;
  linkShown = on;
  if (!on) {
    linkEl.style.display = "none";
    return;
  }
  const lw = Math.min(300, W - 60);
  linkEl.value = shareUrl;
  linkEl.style.left = W / 2 - lw / 2 + "px";
  linkEl.style.top = linkTop() + "px";
  linkEl.style.width = lw + "px";
  linkEl.style.display = "block";
}

function doCopy() {
  copiedAt = ac ? ac.currentTime : 0;
  // The share sheet is the reliable route on iOS -- it's the OS doing the sending,
  // not a clipboard write we can't verify.
  const nav = navigator as any;
  try {
    if (nav.share) {
      nav.share({ title: "Unicorn Storm", url: shareUrl }).catch(() => {});
      return;
    }
  } catch (e) {}
  copyLink(shareUrl, copyBtn.y - 18);
}

function copyLink(url: string, y: number) {
  // Only failure needs announcing: on success the button already reads COPIED and the
  // link is on screen, and the toast was landing behind the round-end panel.
  const done = (good: boolean) => {
    if (!good) say(W / 2, y, "couldn't copy — use the link below", "rgba(255,170,170,1)", 17);
  };
  // execCommand first, not the async Clipboard API. On iOS the async path needs an
  // activation Safari accepts and can fail SILENTLY, so its rejection handler never
  // ran and the fallback never fired. The synchronous path returns a real boolean.
  if (legacyCopy(url)) {
    done(true);
    return;
  }
  const nav = navigator as any;
  try {
    if (nav.clipboard && nav.clipboard.writeText) {
      nav.clipboard.writeText(url).then(() => done(true), () => done(false));
      return;
    }
  } catch (e) {}
  done(false);
}

// Older Safari refuses the async clipboard outside narrow conditions; a selected
// off-screen textarea still works there.
function legacyCopy(url: string) {
  try {
    // The iOS recipe specifically: contentEditable, a Range over the contents, THEN
    // setSelectionRange. A plain .select() on a readonly textarea is ignored there.
    // 16px font stops Safari zooming, and it must be on-screen (1px, transparent).
    const ta = document.createElement("textarea");
    ta.value = url;
    ta.contentEditable = "true";
    ta.readOnly = false;
    ta.style.cssText =
      "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;-webkit-user-select:text";
    document.body.appendChild(ta);

    const r = document.createRange();
    r.selectNodeContents(ta);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    ta.setSelectionRange(0, 999999);

    const ok = document.execCommand("copy");
    sel.removeAllRanges(); // don't leave a selection for iOS to decorate
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
  freeBeat = true;
}

let patternDone = false;

// DONE closes the pattern off and hands you the link in one move. There was no way to
// say "that's the whole thing", and copying was a separate step you had to know to take.
function finishPattern() {
  if (seq.length < 2) return;
  taps = []; // a pattern is the challenge, not a performance
  patternDone = true;
  shareUrl = runUrl();
  shareWhat = `your pattern — ${seq.length} notes`;
  copiedAt = -9;
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

// startRun/startChallenge wait for the audio clock to actually tick before anchoring
// a round, which can take a few frames. The title keeps drawing during that wait, so
// clearing sharedIn first meant a flash of the ordinary title on the way out of
// someone's link. Hold the title back until the round is really underway.
let starting = false;

function startChallenge() {
  ensureAudio();
  starting = true;
  const go = () => {
    starting = false;
    score = 0;
    streak = 0;
    mult = 1;
    retries = 0;
    round = 0;
    accuracy = 0;
    flourish = 0;
    newRound(ac.currentTime, true, true);
  };
  waitForClock(go);
}

function startRun() {
  ensureAudio();
  hgt = [];

  starting = true;
  const go = () => {
    starting = false;
    seq = [];
    score = 0;
    accuracy = 0;
    flourish = 0;
    round = 0;
    streak = 0;
    mult = 1;
    retries = 0;
    newRound(ac.currentTime, true);
  };

  waitForClock(go);
}

// Anchoring a round to a stalled clock is how the game hangs: currentTime never
// advances, so the countdown freezes and no note ever sounds, while every tap gets
// swallowed by the resume guard. Keep trying, and give up cleanly rather than
// starting on a clock that isn't running.
function waitForClock(go: () => void, tries = 6) {
  if (ac.state === "running") {
    go();
    return;
  }
  ensureAudio();
  if (tries > 0) setTimeout(() => waitForClock(go, tries - 1), 180);
  else starting = false; // the paused overlay explains it; another tap retries
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
    leap(i, ok ? NOTE_POWER : 0.25, ok);
    return;
  }

  // Slots are no longer evenly spaced, so find the nearest unclaimed one rather
  // than dividing by the beat.
  taps.push({ i, dt: now - turnAt });

  lastClaimK = -1;
  const win = windowFor();
  const { k } = judgeSlot(offs, judged, turnAt, now, win);
  if (k < 0) {
    leap(i, 0.25);
    flourish = Math.max(0, flourish - 0.15);
    say(lx, ly, "extra", "rgba(255,255,255,.5)", 15);
    return;
  }
  const delta = now - (turnAt + offs[k] * BEAT); // signed: <0 early, >0 late
  const off = Math.abs(delta);
  const timing = timingScore(off, win);
  const right = seq[k] === i;
  judged[k] = right ? timing : 0;
  if (right) {
    lastClaimK = k;
    lastClaimAt = now;
  }

  // Name the error, and say which way. "EARLY" is actionable; a red dot isn't.
  if (!right) {
    say(lx, ly, "wrong one", "rgba(255,110,120,.95)", 17);
  } else {
    // Named band, or the direction and amount when it's the loosest one -- "early
    // 210ms" is still the actionable form once you're outside GOOD.
    const t = tierFor(off, win);
    const col =
      t.name === "PERFECT"
        ? "rgba(160,255,190,1)"
        : t.name === "GREAT"
        ? "rgba(198,255,205,.96)"
        : t.name === "GOOD"
        ? "rgba(255,238,150,.95)"
        : "rgba(255,193,124,.95)";
    say(
      lx,
      ly,
      t.name || `${delta < 0 ? "early" : "late"} ${(off * 1000) | 0}ms`,
      col,
      t.name === "PERFECT" ? 24 : 18
    );
    score += Math.round(t.credit * 100 * mult);
  }

  flourish = heat();

  leap(i, right ? NOTE_POWER : 0.25, right && timing > 0.3);
}

// One place that decides what a note in column `col` means, so a slide behaves
// exactly like a tap in every mode.
function jamNote(i: number) {
  if (jamRec && jamTaps.length < 160) {
    if (!jamTaps.length) jamRecAt = ac.currentTime;
    jamTaps.push({ i, dt: ac.currentTime - jamRecAt });
  }
  if (!freeBeat) {
    freeBeat = true;
    pulseAt = ac.currentTime;
    clickIdx = 0;
  }
  jamHeat = Math.min(1, jamHeat + 0.13);
  note(NOTES[i], herd[i].voice, ac.currentTime, 0.22);
  leap(i, NOTE_POWER);
}

function hitNote(col: number) {
  if (phase === TITLE) freePlay(col);
  else if (phase === JAM) jamNote(col);
  else if (phase === COMPOSE) composeTap(col);
  else if (phase === RESPOND || phase === GRADE) tap(col);
}

// Sliding fires only down where the herd actually stands -- otherwise dragging
// across the buttons would set off notes.
function overHerd(y: number) {
  return y > groundY - 118;
}

// Last column each finger was over. Multi-touch: two fingers can run the herd at once.
const slideCol = new Map<number, number>();
// What each finger (or key) is currently holding aloft.
const heldBy = new Map<string | number, Flyer>();

// Which slot each press claimed, so its release can be judged on height.
const claimed = new Map<string | number, { k: number; at: number }>();
let lastClaimK = -1;
let lastClaimAt = 0;

function grab(id: string | number) {
  if (lastClaimK >= 0) {
    claimed.set(id, { k: lastClaimK, at: lastClaimAt });
    lastClaimK = -1;
  }
  if (!lastLaunched || !heightsLive()) return;
  // A new press from the same pointer means the previous one is over, even if its
  // release never arrived. Without this, a dropped or reordered pointerup leaves the
  // old note armed and disarms the new one -- heights come out swapped.
  const prev = heldBy.get(id);
  if (prev) prev.holding = false;
  // Armed, not lifted: nothing happens unless the hold survives to HOLD_HIGH.
  lastLaunched.armAt = ac.currentTime + HOLD_HIGH;
  lastLaunched.holding = true;
  heldBy.set(id, lastLaunched);
}

function release(id: string | number) {
  const f = heldBy.get(id);
  if (f) f.holding = false; // let go before HOLD_HIGH and it stays a low hop
  heldBy.delete(id);

  const c = claimed.get(id);
  claimed.delete(id);
  if (!c) return;

  if (phase === COMPOSE) {
    if (compHard && c.k < hgt.length) hgt[c.k] = ac.currentTime - c.at > HOLD_HIGH ? 1 : 0;
    return;
  }
  if (!hardcore || phase !== RESPOND || judged[c.k] <= 0) return;

  // Timing was settled on press; height is settled here, on release.
  const gave = ac.currentTime - c.at > HOLD_HIGH ? 1 : 0;
  if (gave === hgt[c.k]) return;

  // Half credit: the right unicorn at the wrong altitude was still recognised,
  // just not delivered.
  judged[c.k] *= 0.45;
  flourish = heat();
  say(herd[seq[c.k]].homeX, groundY - 88, gave ? "too high" : "too low", "rgba(255,200,130,.95)", 15);
}

function column(x: number) {
  return Math.min(COUNT - 1, Math.max(0, Math.round(x / slot) - 1));
}

// Two taps to restart. Losing a long run to a misplaced thumb would be far worse
// than the small friction of confirming.
function shareRun() {
  copyLink(runUrl(), H * 0.44);
}

// Restarts the PHRASE, not the run. Fumbling one round should cost the streak, the
// way TRY AGAIN does -- not the whole run and every point in it. HOME is the way out;
// this is the way back to the top of the level. Nothing is destroyed, so no
// confirmation step either.
// Doesn't restart on the spot -- offers the same two ways back in that the round-end
// screen does, because "start this phrase over" and "let me hear it first" are
// different needs and only you know which one you're in.
let midRestart = false;

function restartLevel() {
  if (!ac || !seq.length || phase === GRADE) return;
  midRestart = true;
  phase = GRADE;
  phaseAt = ac.currentTime;
}

canvas.addEventListener("pointerdown", (e: PointerEvent) => {
  e.preventDefault();
  layoutUtils();
  const x = e.clientX;
  const y = e.clientY;

  // If the clock is parked (iOS suspends it on app switch or lock), the first tap
  // does nothing but wake it. Without this the overlay was a label with no behaviour.
  if (ac && ac.state !== "running") {
    ensureAudio();
    return;
  }

  if (inRect(x, y, homeBtn) && (phase === CALL || phase === RESPOND || phase === GRADE)) {
    hgt = [];
    phase = TITLE;
    hardcore = false;
    return;
  }

  if (inRect(x, y, beatBtn) && phase !== TITLE && phase !== REPLAY) {
    beatOn = !beatOn;
    saveBest();
    return;
  }

  if (phase === JAM) {
    if (inRect(x, y, restartBtn)) {
      phase = TITLE;
      return;
    }
    if (shareUrl && inRect(x, y, copyRect())) {
      doCopy();
      return;
    }
    if (shareUrl && inRect(x, y, hideBtn)) {
      dismissShare();
      return;
    }
    if (inRect(x, y, shareBtn)) {
      if (jamRec) {
        jamRec = false;
        if (jamTaps.length > 1) {
          taps = jamTaps;
          shareUrl = location.origin + location.pathname + "#" + encodeJam(jamTaps);
          shareWhat = `your jam — ${jamTaps.length} notes`;
          copiedAt = -9;
        }
      } else {
        jamRec = true;
        jamTaps = [];
        shareUrl = "";
      }
      return;
    }
    slideCol.set(e.pointerId, column(x));
    canvas.setPointerCapture(e.pointerId);
    jamNote(column(x));
    grab(e.pointerId);
    return;
  }

  if (phase === COMPOSE) {
    if (patternDone && shareUrl && inRect(x, y, copyRect())) {
      doCopy();
      return;
    }
    if (patternDone && shareUrl && inRect(x, y, hideBtn)) {
      dismissShare();
      return;
    }
    if (inRect(x, y, shareBtn)) {
      compHard = !compHard;
      if (!compHard) hgt = hgt.map(() => 0);
      return;
    }
    if (inRect(x, y, hearBtn)) previewPattern(ac.currentTime);
    else if (inRect(x, y, clearBtn)) {
      seq = [];
      offs = [];
      compAt = -1;
      patternDone = false;
      shareUrl = "";
      pending.length = 0;
    } else if (inRect(x, y, sendBtn)) finishPattern();
    else if (inRect(x, y, backBtn)) {
      seq = [];
      offs = [];
      phase = TITLE;
    } else {
      slideCol.set(e.pointerId, column(x));
      canvas.setPointerCapture(e.pointerId);
      patternDone = false; // adding a note reopens it
      composeTap(column(x));
      grab(e.pointerId);
    }
    return;
  }

  if (phase === TITLE && overHerd(y)) {
    slideCol.set(e.pointerId, column(x));
    canvas.setPointerCapture(e.pointerId);
  }

  if (phase === TITLE) {
    if (inRect(x, y, makeBtn)) {
      enterCompose();
      return;
    }
    if (inRect(x, y, jamBtn)) {
      enterJam();
      return;
    }
    if (inRect(x, y, songBtn)) {
      ensureAudio();
      phase = PICK;
      return;
    }
    song = null; // any other way in is not a song run
    if (inRect(x, y, hardBtn)) {
      if (sharedIn) {
        // Arriving by link shouldn't be a dead end -- offer your own game too. Drop
        // the hash with it, or the address bar still claims to be their run and a
        // reload drags you back into it.
        sharedIn = sharedJam = false;
        hardcore = false;
        seq = [];
        try {
          history.replaceState(null, "", location.pathname + location.search);
        } catch (e) {}
        startRun();
      } else {
        // Unlock audio HERE. This was the only entry point that changed screens
        // without touching the audio context, so hardcore reached BRING IT ON with
        // nothing unlocked and had to create the context on a later gesture.
        ensureAudio();
        phase = BRIEF;
      }
      return;
    }
    if (overHerd(y) && !inRect(x, y, playBtn) && !inRect(x, y, makeBtn) && !inRect(x, y, jamBtn)) {
      freePlay(column(x));
      grab(e.pointerId);
      return;
    }
    if (inRect(x, y, playBtn)) {
      hardcore = false;
      if (sharedJam) playJam((ensureAudio(), ac.currentTime));
      else if (sharedIn && taps.length) startReplay((ensureAudio(), ac.currentTime));
      else if (sharedIn) startChallenge();
      else startRun();
    }
    return;
  }

  if (phase === PICK) {
    if (inRect(x, y, restartBtn)) {
      phase = TITLE;
      return;
    }
    for (let i = 0; i < SONGS.length; i++) {
      if (!inRect(x, y, songRect(i))) continue;
      song = songAt(i);
      hardcore = false;
      seq = [];
      startRun();
      return;
    }
    return;
  }

  if (phase === BRIEF) {
    if (inRect(x, y, goBtn)) {
      hardcore = true;
      startRun();
    } else if (inRect(x, y, restartBtn)) phase = TITLE;
    return;
  }

  if (phase === REPLAY) return; // let it play out

  if (inRect(x, y, restartBtn) && (phase === CALL || phase === RESPOND || phase === GRADE)) {
    restartLevel();
    return;
  }
  if (shareUrl && inRect(x, y, copyRect())) {
    doCopy();
    return;
  }
  if (shareUrl && inRect(x, y, hideBtn)) {
    dismissShare();
    return;
  }
  if (inRect(x, y, shareBtn)) {
    shareUrl = runUrl();
    shareWhat = `your run — ${seq.length} notes, ${score} pts`;
    doCopy();
    return;
  }

  if (phase === GRADE) {
    // Guard against the last note of a phrase bleeding into the choice screen.
    const now = ac.currentTime;
    if (now < phaseAt + 0.4) return;
    if (inRect(x, y, againBtn)) newRound(now, false);
    else if (grew && !midRestart && inRect(x, y, nextBtn)) newRound(now, true);
    else if (inRect(x, y, blindBtn)) retryBlind(now);
    return;
  }

  if (overHerd(y)) {
    slideCol.set(e.pointerId, column(x));
    canvas.setPointerCapture(e.pointerId);
  }
  tap(column(x));
  grab(e.pointerId);
});

// Drag across the herd to run notes off like a glissando. Each unicorn fires once as
// the finger crosses into its column, and again only if you leave and come back.
canvas.addEventListener("pointermove", (e: PointerEvent) => {
  if (!slideCol.has(e.pointerId)) return;
  if (!overHerd(e.clientY)) return;
  const c = column(e.clientX);
  if (c === slideCol.get(e.pointerId)) return;
  slideCol.set(e.pointerId, c);
  hitNote(c);
  grab(e.pointerId); // the new one becomes what this finger is holding
});

for (const ev of ["pointerup", "pointercancel", "pointerleave"]) {
  canvas.addEventListener(ev, (e: any) => {
    slideCol.delete(e.pointerId);
    release(e.pointerId);
  });
}

addEventListener("keyup", (e: KeyboardEvent) => release(e.key));

addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.repeat) return;
  const i = "12345".indexOf(e.key);
  if (phase === TITLE) {
    if (i >= 0) freePlay(i);
    else if (e.key === " " || e.key === "Enter") startRun();
    else if (e.key.toLowerCase() === "j") enterJam();
    return;
  }
  if (phase === JAM) {
    if (i >= 0) {
      jamNote(i);
      grab(e.key);
    } else if (e.key === "Escape") phase = TITLE;
    return;
  }
  if (phase === GRADE) {
    const now = ac.currentTime;
    if (now < phaseAt + 0.4) return;
    if (e.key === "Enter" || e.key === " ") newRound(now, grew && !midRestart);
    else if (e.key.toLowerCase() === "a") newRound(now, false);
    else if (e.key.toLowerCase() === "g") retryBlind(now);
    else if (e.key.toLowerCase() === "r") restartLevel();
    return;
  }
  if (i >= 0) {
    tap(i);
    grab(e.key);
  } else if (e.key.toLowerCase() === "r") restartLevel();
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
      // In hardcore the call shows the height too: a high note visibly soars, which is
      // the only way the player can learn what to give back.
      const f = leap(seq[visIdx], NOTE_POWER);
      if (hgt[visIdx]) {
        // The herd "holds" its own note, through the very same mechanism.
        f.armAt = now + HOLD_HIGH;
        f.holding = true;
      }
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
      for (let i = 0; i < seq.length; i++) {
        // Name the notes that never got played -- silence is the least readable failure.
        if (judged[i] < 0) say(herd[seq[i]].homeX, groundY - 44, "missed", "rgba(255,110,120,.85)", 15);
      }
      accuracy = accuracyOf(judged, seq.length);
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
    // A shared jam has no round behind it, so it lands back on the title.
    phase = sharedJam ? TITLE : GRADE;
    phaseAt = now;
  }

  // Runs wherever there's playing to do -- not while a round-end screen waits on you.
  const beatLive =
    phase === CALL || phase === RESPOND ? true : (phase === COMPOSE || phase === JAM) && freeBeat;
  if (beatOn && beatLive) {
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
  // One flat tone for the entire body -- barrel, belly, neck, head, ear and legs.
  // Mane, tail, horn and eye stay as accents; everything else is a single silhouette.
  const lit = `hsl(${hue},72%,${66 + glow * 12}%)`;
  const pale = `hsl(${hue},76%,${74 + glow * 10}%)`;

  // legs -- straight segments with a hard knee. Body tone, not the shadow tone: at
  // 3px a flat darker stroke reads as a different material rather than as shading.
  ctx.strokeStyle = lit;
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

  ctx.fillStyle = lit;
  poly([-14, 0, -9, -8, 1, -9, 9, -5, 10, 4, -2, 6, -11, 5]); // barrel
  ctx.fill();
  poly([4, -7, 10, -18, 15, -17, 9, -4]); // neck
  ctx.fill();
  poly([10, -18, 22, -15, 17, -8, 9, -11]); // wedge head
  ctx.fill();
  // The ear still reads because its tip clears the skull line against the sky.
  poly([10.2, -16.6, 9.2, -24.5, 13.6, -15.8]);
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

// Letters knocked off true, one at a time. HARDCORE should look like it's shouting.
function wonkyHard() {
  wonky("HARDCORE", hardBtn.x + hardBtn.w / 2, hardBtn.y + 30, Math.min(17, hardBtn.w / 7.4), "", true);
}

function wonky(str: string, cx: number, cy: number, size: number, col: string, bow?: boolean) {
  ctx.letterSpacing = "0px";
  ctx.font = `800 ${size}px system-ui,-apple-system,sans-serif`;
  ctx.textAlign = "center";
  ctx.fillStyle = col;
  let x = cx - ctx.measureText(str).width / 2;
  for (let i = 0; i < str.length; i++) {
    const w = ctx.measureText(str[i]).width;
    ctx.save();
    if (bow) ctx.fillStyle = `hsl(${(i / str.length) * 320},92%,66%)`;
    ctx.translate(x + w / 2, cy + Math.sin(i * 1.9) * 2.4);
    ctx.rotate(Math.sin(i * 2.3 + 1) * 0.3);
    ctx.fillText(str[i], 0, 0);
    ctx.restore();
    x += w;
  }
}

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

  // Opaque backing first. The tint below is semi-transparent, and the shadow only
  // covers the button from the offset inward -- so without this the top-left strip
  // showed sky through the fill while the rest showed shadow, reading as a gap
  // between the border and the interior.
  chamfer(r.x, r.y, r.w, r.h, c);
  ctx.fillStyle = "#131226";
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
  // QUIET buttons share one size regardless of label length, so the utility row reads
  // as a single unit rather than four differently-shouting words.
  const size = tone === QUIET ? 12.5 : Math.min(sub ? 16 : 18, r.w / (label.length * 0.72 + 2));
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

// The share affordance. Says what it will hand over, and confirms on the button
// itself rather than in a toast that's gone before you look up.
// The panel sits in different places per screen, so one function owns the position
// and both drawing and hit-testing read it. Behaviour is identical everywhere.
// Utility controls live in a row along the bottom, where there is dead space on every
// screen. Stacked in the top-left they crowded the phrase dots and the score, and on a
// tall phone HOME landed on top of the round-end panel. Laid out per phase, and called
// from both drawing and hit-testing so the two can never disagree.
function layoutUtils() {
  const n = phase === JAM ? 3 : phase === COMPOSE ? 1 : 4;
  const uw = Math.min(96, (W - 40) / n - 8);
  const y = H - 66;
  const x0 = (W - (n * uw + (n - 1) * 8)) / 2;
  const at = (i: number) => ({ x: x0 + i * (uw + 8), y, w: uw, h: 32 });
  if (phase === JAM) {
    Object.assign(restartBtn, at(0));
    Object.assign(beatBtn, at(1));
    Object.assign(shareBtn, at(2));
  } else if (phase === COMPOSE) {
    Object.assign(beatBtn, at(0));
  } else {
    Object.assign(restartBtn, at(0));
    Object.assign(beatBtn, at(1));
    Object.assign(homeBtn, at(2));
    Object.assign(shareBtn, at(3));
  }
}

function copyRect() {
  copyBtn.y = phase === JAM ? H * 0.14 + 96 : phase === COMPOSE ? H * 0.16 + 96 : nextBtn.y + nextBtn.h + 22;
  // Narrower than before to make room for a dismiss: after STOP in jam the panel had
  // no way out at all, and it sat over the herd you were trying to play.
  copyBtn.w = Math.min(238, W - 116);
  copyBtn.x = (W - copyBtn.w - 52) / 2;
  hideBtn.w = 44;
  hideBtn.h = copyBtn.h;
  hideBtn.x = copyBtn.x + copyBtn.w + 8;
  hideBtn.y = copyBtn.y;
  return copyBtn;
}

function dismissShare() {
  shareUrl = "";
  copiedAt = -9;
  showLink(false);
}

function drawCopy(now: number) {
  copyRect();
  btn(hideBtn, "✕", undefined, QUIET);
  const fresh = now - copiedAt < 3;
  const sharey = !!(navigator as any).share;
  text(shareWhat, W / 2, copyBtn.y - 14, 14, 0.5);
  btn(copyBtn, sharey ? "SEND IT" : fresh ? "COPIED" : "COPY LINK", undefined, fresh && !sharey ? PLAIN : GOLD);
  text(
    sharey ? "or long-press the link below to copy it" : "or select the link below",
    W / 2,
    copyBtn.y + copyBtn.h + 22,
    12,
    0.42
  );
  showLink(true);
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
  if (phase === JAM) {
    // Fades over roughly four seconds of silence.
    jamHeat = Math.max(0, jamHeat - dt * 0.24);
    flourish = jamHeat;
  }

  // Playing well BURNS OFF the storm: the sky lifts from a dark squall toward a warm
  // clear evening, the cloud bank thins, and the lightning backs off. The herd is
  // driving the weather away rather than summoning it.
  const lift = phase === TITLE ? 0 : flourish;
  const sky = ctx.createLinearGradient(0, 0, 0, groundY);
  // Two gradients cross-faded, NOT one gradient with interpolated hue: blue 198 to
  // gold 40 travels through green, which turned the horizon lime. Alpha blending goes
  // straight there. Clearing evening, not midday -- the additive ribbons need
  // something darker than daylight to read against.
  sky.addColorStop(0, "hsl(230,58%,9%)");
  sky.addColorStop(0.55, "hsl(216,52%,19%)");
  sky.addColorStop(1, "hsl(198,48%,31%)");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  if (lift > 0.01) {
    const warm = ctx.createLinearGradient(0, 0, 0, groundY);
    warm.addColorStop(0, `hsla(226,46%,22%,${lift})`);
    warm.addColorStop(0.55, `hsla(24,44%,34%,${lift * 0.85})`);
    warm.addColorStop(1, `hsla(34,68%,52%,${lift * 0.9})`);
    ctx.fillStyle = warm;
    ctx.fillRect(0, 0, W, H);
  }


  for (const c of clouds) {
    c.x -= c.v * dt;
    if (c.x < -160 * c.s) c.x = W + 160 * c.s;
    drawCloud(c, lift);
  }

  // Inverted deliberately: the storm is the thing you are driving off. Frequent and
  // bright while you are struggling, near-still once the run is clean.
  const weather = phase === TITLE ? 0.3 : 1 - flourish;
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
    for (let L = 0; L < b.legs.length; L++) {
      const pts = b.legs[L];
      const main = L === 0; // forks are thinner and dimmer than the trunk
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      for (let p = 2; p < pts.length; p += 2) ctx.lineTo(pts[p], pts[p + 1]);
      ctx.strokeStyle = `rgba(150,205,255,${a * (main ? 0.3 : 0.16) * b.power})`;
      ctx.lineWidth = (main ? 11 : 5) * b.power + 2;
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${a * (main ? 0.9 : 0.55)})`;
      ctx.lineWidth = main ? 2.4 : 1.3;
      ctx.stroke();
    }
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

    // The snap: one impulse that retargets the apex to the canonical high.
    if (f.armAt && f.holding && now >= f.armAt) {
      f.armAt = 0;
      const rise = f.y - (groundY - H * HIGH_F);
      if (rise > 0) {
        const v = Math.sqrt(2 * f.g * rise);
        if (v > -f.vy) f.vy = -v;
      }
      f.glow = Math.min(1, f.glow + 0.4); // the surge should be felt as well as seen
    }

    f.vy += f.g * dt;
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

  // "lighter" sums channels, so a dense burst of mixed hues saturates to white by
  // definition. "screen" approaches white asymptotically instead, so colours survive
  // the pile-up.
  ctx.globalCompositeOperation = "screen";
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
    ctx.fillStyle = p.white ? `rgba(255,255,255,${a * 0.8})` : `hsla(${p.hue},95%,62%,${a * 0.95})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, a * 3.5 + 0.6, 0, 6.284);
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";

  // Ground brightens on every beat -- a visible pulse to play against, so the
  // rhythm isn't carried by the click alone.
  let pulse = 0;
  const pulseLive =
    phase === CALL || phase === RESPOND ? true : (phase === COMPOSE || phase === JAM) && freeBeat;
  if (ac && beatOn && pulseLive) {
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
  layoutUtils();
  if (phase !== JAM && phase !== COMPOSE && phase !== GRADE) showLink(false);

  if (phase === TITLE) {
    if (starting) return; // a run is spinning up; don't flash the menu on the way out
    fitText("UNICORN STORM", W / 2, H * 0.24, W * 0.84, 68, 0.96);
    text("Simon says repeat after the unicorns", W / 2, H * 0.24 + 42, Math.min(19, W / 27), 0.55);

    // One obvious target. It breathes so it reads as the live thing on screen.
    btn(
      playBtn,
      sharedJam ? "HEAR THIS JAM" : sharedIn ? (taps.length ? "WATCH REPLAY" : "TRY THIS") : "PLAY",
      undefined,
      GOLD
    );
    if (sharedIn)
      text("someone sent you this", W / 2, playBtn.y - 16, Math.min(15, W / 34), 0.45);

    // The herd is live here: hearing the five voices before being graded on them
    // is the cheapest tutorial there is.
    btn(songBtn, "SONGS");
    if (sharedIn) btn(hardBtn, "NEW GAME");
    else {
      btn(hardBtn, "");
      wonkyHard();
    }
    btn(jamBtn, "JAM");
    btn(makeBtn, "PATTERN");

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

  if (phase === PICK) {
    text("songs", W / 2, H * 0.16, 26, 0.85);
    text("real tunes, revealed a note at a time", W / 2, H * 0.16 + 26, 14, 0.45);
    for (let i = 0; i < SONGS.length; i++) {
      const s = songAt(i);
      choice(songRect(i), s.name, `${s.seq.length} notes`, false);
    }
    btn(restartBtn, "BACK", undefined, QUIET);
    return;
  }

  if (phase === BRIEF) {
    wonky("HARDCORE", W / 2, H * 0.2, Math.min(52, W / 9), "", true);
    // Leads with the verb, because the hold is the only genuinely new skill. The
    // consequence and the reassurance are small print -- true, but not what you need
    // in the first two seconds.
    const big = Math.min(21, W / 22);
    const small = Math.min(14, W / 32);
    text("TAP for a low hop", W / 2, H * 0.2 + 48, big, 0.92);
    text("HOLD for a high leap", W / 2, H * 0.2 + 76, big, 0.92);
    // Name the thing you can actually see. "shows you which it wants" describes the
    // rule; "how high each one jumps" describes the screen.
    text("watch how high each one jumps, then copy it", W / 2, H * 0.2 + 112, small, 0.6);
    text("wrong height still scores, but only 45%", W / 2, H * 0.2 + 140, small, 0.4);
    text("rhythm arrives sooner. timing is unchanged.", W / 2, H * 0.2 + 162, small, 0.4);
    btn(goBtn, "BRING IT ON", undefined, GOLD);
    btn(restartBtn, "BACK", undefined, QUIET);
    if (ac && ac.state !== "running") text("tap again to wake the sound", W / 2, H - 92, 14, 0.6);
    return;
  }

  if (phase === JAM) {
    btn(restartBtn, "BACK", undefined, QUIET);
    btn(beatBtn, beatOn ? "BEAT ON" : "BEAT OFF", undefined, QUIET);
    btn(shareBtn, jamRec ? "STOP" : "REC", undefined, jamRec ? GOLD : QUIET);
    if (jamRec) {
      text(`recording — ${jamTaps.length} notes`, W / 2, H * 0.14 + 82, 13, 0.6);
      showLink(false);
    } else if (shareUrl) drawCopy(now);
    else showLink(false);
    text("jam", W / 2, H * 0.14, 26, 0.8);
    text("no timer, no score — tap for a hop, hold for a leap", W / 2, H * 0.14 + 26, 15, 0.4);
    // The storm gauge is the only readout: it IS how hard you're playing.
    const gw = Math.min(220, W * 0.5);
    ctx.fillStyle = "rgba(255,255,255,.1)";
    ctx.fillRect(W / 2 - gw / 2, H * 0.14 + 44, gw, 4);
    ctx.fillStyle = `hsla(${45 + jamHeat * 160},90%,68%,${0.5 + jamHeat * 0.5})`;
    ctx.fillRect(W / 2 - gw / 2, H * 0.14 + 44, gw * jamHeat, 4);
    // It was an unlabelled bar, which is no better than no bar.
    text("storm — keep playing to build it", W / 2, H * 0.14 + 64, 12, 0.32);
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
    text(
      compHard ? "hold a unicorn to write a high note" : "notes snap to the nearest half beat",
      W / 2,
      H * 0.16 + 50,
      13,
      0.3
    );
    btn(shareBtn, compHard ? "HARDCORE" : "NORMAL", undefined, compHard ? GOLD : QUIET);

    // the pattern so far, spaced by time
    if (seq.length) {
      const beats = Math.max(1, offs[offs.length - 1]);
      const span = Math.min(W - 96, Math.max(120, 30 * beats));
      const x0 = W / 2 - span / 2;
      for (let i = 0; i < seq.length; i++) {
        ctx.beginPath();
        ctx.arc(x0 + (offs[i] / beats) * span, H * 0.16 + 84, hgt[i] ? 9 : 6, 0, 6.284);
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
      [sendBtn, "DONE", on],
      [backBtn, "BACK", true],
    ] as [typeof clearBtn, string, boolean][]) {
      btn(r, label, undefined, live ? (label === "DONE" ? GOLD : PLAIN) : LOCKED);
    }
    const hintY = hearBtn.y + 82;
    if (!on) text("at least two notes to send", W / 2, hintY, 12, 0.3);
    else if (!patternDone) text("DONE finishes it and gives you a link", W / 2, hintY, 12, 0.34);
    if (patternDone && shareUrl) drawCopy(now);
    else showLink(false);

    btn(beatBtn, beatOn ? "BEAT ON" : "BEAT OFF", undefined, QUIET);
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
      const hr = hgt[i] ? r * 1.65 : r; // a high note is a bigger pip
      ctx.arc(x0 + (offs[i] / beats) * span, dotY, i === cursor ? hr + 2.5 : hr, 0, 6.284);
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
    const big = message === "PERFECT" && !midRestart;
    // Scrim: at high scores the celebration is bright enough to swallow the UI.
    const pw = Math.min(W - 32, 520);
    const py = H * 0.2 - 42;
    rrect((W - pw) / 2, py, pw, nextBtn.y + nextBtn.h + 16 - py, 26);
    ctx.fillStyle = "rgba(12,9,28,.62)";
    ctx.fill();

    if (midRestart) {
      text("start this phrase over", W / 2, H * 0.2, 26, 0.85);
      text("your score and streak carry on", W / 2, H * 0.2 + 30, 14, 0.45);
    } else {
      text(message, W / 2, H * 0.2, big ? 46 : 28, big ? 0.95 : 0.8);
      text(`${(accuracy * 100) | 0}% match`, W / 2, H * 0.2 + 34, 18, 0.55);
      if (combo) text(`${combo} midair bonus`, W / 2, H * 0.2 + 56, 15, 0.5);
    }

    choice(blindBtn, "TRY AGAIN", "same phrase, play now", midRestart || !grew);
    choice(againBtn, "HEAR IT AGAIN", "the herd plays it first", false);
    // No NEXT from a mid-round restart -- you haven't finished the phrase.
    if (midRestart) choice(nextBtn, "NEXT!", "finish the phrase first", false, true);
    else if (grew) choice(nextBtn, "NEXT!", "one note longer", true);
    else choice(nextBtn, "NEXT!", "needs 50%", false, true);

    // The copy panel does NOT belong in here -- stacked under the choices it pushed
    // its own heading behind NEXT! and buried the link off the bottom. In play,
    // COPY in the utility row does the copying and the link appears below the panel.
    if (shareUrl) {
      showLink(true);
      text("your link is below — long-press to copy", W / 2, linkTop() - 12, 12, 0.4);
    }
  }

  if (round <= 1 && phase === CALL && now - (phaseAt - BEAT * LEADIN) < 6) {
    // H-44 is inside the utility row now that it lives along the bottom; this sits in
    // the clear band between the herd and the buttons.
    text("sound on?", W / 2, H - 92, 15, 0.4);
  }

  {
    btn(restartBtn, "RESTART", undefined, QUIET);
    btn(beatBtn, beatOn ? "BEAT ON" : "BEAT OFF", undefined, QUIET);
    btn(homeBtn, "HOME", undefined, QUIET);
    btn(shareBtn, now - copiedAt < 3 ? "COPIED" : "COPY", undefined, QUIET);
  }

  if (ac.state !== "running") {
    ctx.fillStyle = "rgba(10,8,24,.72)";
    ctx.fillRect(0, 0, W, H);
    text("paused", W / 2, H * 0.46, 30, 0.9);
    text("tap anywhere to resume", W / 2, H * 0.46 + 30, 18, 0.6);
    // Surfaced deliberately: if a tap still won't clear this, the state name says why.
    text(`audio: ${ac.state}`, W / 2, H * 0.46 + 56, 13, 0.35);
  }

  text(
    // Everything about the run on one line, each part labelled. An unlabelled number
    // floating at the top told you nothing and collided with the round-end panel.
    `${song ? song.name + "   " : hardcore ? "HARDCORE   " : ""}${score} pts   ${seq.length}/${
      song ? song.seq.length : seq.length
    } notes${
      mult > 1 ? `   x${mult.toFixed(1)}` : ""
    }   best ${best}`,
    W / 2,
    H - 16,
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
