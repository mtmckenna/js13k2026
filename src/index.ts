// ECHO -- a call-and-response rhythm game.
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
const REST = 4; // beats between the call and your turn -- a full bar, counted down
const LEADIN = 4; // beats of countdown before the herd starts playing

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
  glow: number;
  hot: boolean; // launched by a correct note -- only these can score a collision bonus
  ribbon: Ribbon;
}

const herd: Unicorn[] = [];
for (let i = 0; i < COUNT; i++) {
  herd.push({ homeX: 0, hue: HUES[i], voice: VOICES[i], bob: Math.random() * 6.28, lit: 0 });
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

function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  W = innerWidth;
  H = innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  groundY = H * 0.82;
  slot = W / (COUNT + 1);
  for (let i = 0; i < herd.length; i++) herd[i].homeX = slot * (i + 1);
}
addEventListener("resize", resize);

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

let phase = TITLE;
let phaseAt = 0; // audio-clock time this phase began
let seq: number[] = [];
let round = 0;
let best = 0;

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
// The response clock starts on the player's FIRST tap, not on a countdown. The
// opening note is therefore a gimme: it can't be early or late, it just sets the
// beat everything after it is measured against.
let turnAt = -1; // -1 until they commit; then the origin of their phrase
let pulseAt = 0; // what the metronome and ground flash are anchored to

// Grow by APPENDING one note, never by regenerating. A fresh random phrase every
// round is a memory test with no memory in it -- the whole gentleness of Simon comes
// from the phrase you already know staying put, with one new note on the end.
function newRound(now: number, grow: boolean) {
  if (!seq.length) seq = [(Math.random() * COUNT) | 0, (Math.random() * COUNT) | 0];
  else if (grow) seq.push((Math.random() * COUNT) | 0);

  judged = seq.map(() => -1);
  schedIdx = visIdx = 0;
  clickIdx = -LEADIN; // click through the countdown so the tempo is set before note 1
  cued = false;
  combo = 0;
  phase = CALL;
  phaseAt = now + BEAT * LEADIN;
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

function respondStart() {
  return phaseAt + (seq.length - 1 + REST) * BEAT;
}

// --- leaping -------------------------------------------------------------

function leap(i: number, power: number, hot?: boolean) {
  const u = herd[i];

  // Exaggeration is the reward: arcs swell with `power`, which tracks how well
  // the player is doing right now.
  const peak = H * (0.2 + power * 0.34);
  const vy = Math.sqrt(2 * G * peak);
  const flight = (2 * vy) / G;

  let dir = i % 2 ? -1 : 1;
  const reach = peak * 1.7;
  if (u.homeX + dir * reach < 40 || u.homeX + dir * reach > W - 40) dir = -dir;

  const ribbon = { hue: u.hue, pts: [], age: 0, fat: 0.6 + power };
  ribbons.push(ribbon);
  flyers.push({
    x: u.homeX,
    y: groundY - 6,
    vx: (dir * reach) / flight,
    vy: -vy,
    hue: u.hue,
    glow: 0.3 + power * 0.7,
    hot: !!hot,
    ribbon,
  });
  u.lit = 1;
}

function burst(x: number, y: number, h1: number, h2: number, power: number) {
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
  if (ac) {
    ping(NOTES[0] * 4, 0.06 + power * 0.1);
    ping(NOTES[2] * 4, 0.06 + power * 0.1);
  }
}

// --- input ---------------------------------------------------------------

function tap(i: number) {
  if (!ac) {
    ac = new (window.AudioContext || (window as any).webkitAudioContext)();
    newRound(ac.currentTime, true);
    return;
  }
  if (ac.state === "suspended") ac.resume();
  const now = ac.currentTime;

  if (phase === GRADE) {
    // Wait for the player between rounds. The half-second guard stops the final
    // note of a phrase from advancing the round it just finished.
    if (now > phaseAt + 0.5) newRound(now, grew);
    return;
  }

  if (phase !== RESPOND) {
    // Free play outside your turn -- noodling should always be allowed.
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
    const ok = seq[0] === i;
    judged[0] = ok ? 1 : 0;
    if (ok) {
      score += 100;
      say(lx, ly, "go!", "rgba(160,255,190,1)", 24);
    } else {
      say(lx, ly, "wrong one", "rgba(255,110,120,.95)", 17);
    }
    flourish = heat();
    leap(i, ok ? 0.35 + flourish : 0.2, ok);
    return;
  }

  const k = Math.round((now - turnAt) / BEAT);
  if (k < 0 || k >= seq.length || judged[k] >= 0) {
    leap(i, 0.3); // stray tap: it still leaps, just joylessly
    flourish = Math.max(0, flourish - 0.15);
    say(lx, ly, "extra", "rgba(255,255,255,.5)", 15);
    return;
  }

  const delta = now - (turnAt + k * BEAT); // signed: <0 early, >0 late
  const off = Math.abs(delta);
  const timing = Math.max(0, 1 - off / WINDOW);
  const right = seq[k] === i;
  judged[k] = right ? timing : 0;

  // Name the error, and say which way. "EARLY" is actionable; a red dot isn't.
  if (!right) {
    say(lx, ly, "wrong one", "rgba(255,110,120,.95)", 17);
  } else if (timing > 0.82) {
    say(lx, ly, "PERFECT", "rgba(160,255,190,1)", 24);
    score += 100;
  } else {
    const word = delta < 0 ? "early" : "late";
    const col = timing > 0.5 ? "rgba(255,235,150,.95)" : "rgba(255,190,120,.95)";
    say(lx, ly, `${word} ${(off * 1000) | 0}ms`, col, 17);
    score += (timing * 100) | 0;
  }

  flourish = heat();

  leap(i, right ? 0.35 + flourish : 0.2, right && timing > 0.3);
}

canvas.addEventListener("pointerdown", (e: PointerEvent) => {
  e.preventDefault();
  tap(Math.min(COUNT - 1, Math.max(0, Math.round(e.clientX / slot) - 1)));
});

addEventListener("keydown", (e: KeyboardEvent) => {
  const i = "12345".indexOf(e.key);
  if (i >= 0) tap(i);
});

// --- phase machine -------------------------------------------------------

function update(now: number) {
  if (phase === CALL) {
    // Audio runs ahead of the picture: schedule notes up to 120ms early so they
    // land exactly on the beat, and let the visuals catch up in their own frame.
    while (schedIdx < seq.length) {
      const at = phaseAt + schedIdx * BEAT;
      if (at > now + 0.12) break;
      note(NOTES[seq[schedIdx]], herd[seq[schedIdx]].voice, at, 0.24);
      schedIdx++;
    }
    while (visIdx < seq.length && now >= phaseAt + visIdx * BEAT) {
      leap(seq[visIdx], 0.45 + flourish * 0.55);
      visIdx++;
    }

    // A rising two-note pickup on the beat before your turn, scheduled on the audio
    // clock like everything else. The handover was the thing that felt ambiguous.
    if (!cued && now > respondStart() - BEAT * 1.6) {
      cued = true;
      note(NOTES[0] * 2, "sine", respondStart() - BEAT, 0.13);
      note(NOTES[2] * 2, "sine", respondStart() - BEAT * 0.5, 0.15);
    }

    if (now >= respondStart() - BEAT * 0.5) {
      phase = RESPOND;
      message = "";
      goAt = now;
    }
  } else if (phase === RESPOND) {
    // If they never tapped, end the turn after a generous wait rather than hanging.
    const endAt =
      turnAt < 0
        ? respondStart() + (seq.length + 4) * BEAT
        : turnAt + (seq.length - 1) * BEAT + WINDOW;
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

      if (accuracy > 0.98) {
        message = "PERFECT";
        for (let i = 0; i < COUNT; i++) {
          burst(slot * (i + 1), groundY - H * 0.3 * Math.random() - 60, HUES[i], HUES[(i + 2) % COUNT], 1);
        }
      } else if (accuracy >= 0.5) {
        message = PASS[round % PASS.length];
      } else {
        message = FAIL[round % FAIL.length];
      }
      grew = accuracy >= 0.5;
      if (grew && seq.length > best) best = seq.length;
    }
  }

  // Metronome runs through the call and the response, but not while waiting.
  if (phase === CALL || phase === RESPOND) {
    for (;;) {
      const at = pulseAt + clickIdx * BEAT;
      if (at > now + 0.12) break;
      if (at >= ac.currentTime - 0.05) click(at, clickIdx % 4 === 0);
      clickIdx++;
    }
  }
}

// --- render --------------------------------------------------------------

function drawUnicorn(x: number, y: number, hue: number, vx: number, vy: number, glow: number) {
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

  ctx.fillStyle = `hsl(${hue},72%,${66 + glow * 12}%)`;
  ctx.beginPath();
  ctx.ellipse(0, 0, 15, 10, 0, 0, 6.284);
  ctx.fill();

  ctx.strokeStyle = `hsl(${hue},62%,58%)`;
  ctx.lineWidth = 3.5;
  ctx.lineCap = "round";
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(-9 + i * 6, 6);
    ctx.lineTo(-11 + i * 6, 15);
    ctx.stroke();
  }

  ctx.fillStyle = `hsl(${hue},75%,72%)`;
  ctx.beginPath();
  ctx.ellipse(13, -10, 7, 6, 0.4, 0, 6.284);
  ctx.fill();

  ctx.fillStyle = "#ffd75e";
  ctx.beginPath();
  ctx.moveTo(15, -16);
  ctx.lineTo(20, -28);
  ctx.lineTo(11, -17);
  ctx.fill();

  for (let i = 0; i < 4; i++) {
    ctx.strokeStyle = `hsl(${hue + i * 9 - 14},92%,${76 - i * 4}%)`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(6 - i * 2, -9 + i * 3);
    ctx.quadraticCurveTo(-2 - i * 3, -14 + i * 3, -10 - i * 3, -4 + i * 4);
    ctx.stroke();
  }

  ctx.fillStyle = "#3a2b4d";
  ctx.beginPath();
  ctx.arc(15, -11, 1.4, 0, 6.284);
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

  // sky -- brightens with flourish, so a good run visibly lifts the world
  const lift = phase === TITLE ? 0 : flourish;
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, `hsl(255,45%,${11 + lift * 9}%)`);
  sky.addColorStop(1, `hsl(275,42%,${19 + lift * 12}%)`);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

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
      burst(mx, my, a.hue, b.hue, bonus ? 1 : 0.3 + flourish);
      if (bonus) {
        score += 250;
        combo++;
        a.hot = b.hot = false; // one payout per pair
        say(mx, my - 20, "+250", "rgba(255,240,160,1)", 26);
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
  ctx.fillStyle = `rgba(255,255,255,${0.09 + pulse * 0.1})`;
  ctx.fillRect(0, groundY + 16, W, H);
  if (pulse > 0.02) {
    ctx.fillStyle = `rgba(255,255,255,${pulse * 0.5})`;
    ctx.fillRect(0, groundY + 16, W, 2);
  }

  for (const f of flyers) drawUnicorn(f.x, f.y - 14, f.hue, f.vx, f.vy, f.glow);

  for (const u of herd) {
    u.lit = Math.max(0, u.lit - dt * 1.6);
    u.bob += dt * 2.2;
    drawUnicorn(u.homeX, groundY - 14 - Math.abs(Math.sin(u.bob)) * 3, u.hue, 1, 0, u.lit);
  }

  // --- hud ---
  if (phase === TITLE) {
    text("ECHO", W / 2, H * 0.32, Math.min(74, W / 7), 0.95);
    text("the herd plays a phrase. play it back.", W / 2, H * 0.32 + 44, Math.min(19, W / 26), 0.6);
    // The game is unplayable silent, and on iOS the ringer switch mutes WebAudio
    // with no other symptom -- worth saying plainly before anyone starts.
    text("TURN YOUR SOUND ON", W / 2, H * 0.32 + 92, Math.min(22, W / 22), 0.9);
    text("(on iPad, check the silent switch)", W / 2, H * 0.32 + 118, Math.min(15, W / 34), 0.45);
    text("tap or click anywhere to play", W / 2, H * 0.32 + 162, Math.min(19, W / 28), 0.6);
    return;
  }

  // Sequence dots: one per note, so you can see how long the phrase is and,
  // during your turn, which beat you're on.
  const dotY = 42;
  const spread = Math.min(34, W / (seq.length + 3));
  const x0 = W / 2 - ((seq.length - 1) * spread) / 2;
  const cursor = phase === RESPOND ? (turnAt < 0 ? 0 : Math.round((now - turnAt) / BEAT)) : -1;
  for (let i = 0; i < seq.length; i++) {
    const x = x0 + i * spread;
    ctx.beginPath();
    ctx.arc(x, dotY, i === cursor ? 8 : 5.5, 0, 6.284);
    if (phase === CALL) {
      ctx.fillStyle = i < visIdx ? `hsl(${HUES[seq[i]]},80%,66%)` : "rgba(255,255,255,.16)";
    } else if (judged[i] >= 0) {
      ctx.fillStyle =
        judged[i] > 0.55 ? "rgba(150,255,180,.95)" : judged[i] > 0 ? "rgba(255,225,120,.9)" : "rgba(255,110,120,.85)";
    } else {
      ctx.fillStyle = i === cursor ? "rgba(255,255,255,.7)" : "rgba(255,255,255,.16)";
    }
    ctx.fill();
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
    } else if (visIdx >= seq.length && toTurn <= REST) {
      countdown("your turn in", toTurn);
    } else {
      text("listen", W / 2, H * 0.2, 22, 0.5);
    }
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
    text(message, W / 2, H * 0.2, big ? 46 : 28, big ? 0.95 : 0.8);
    if (!big) text(`${(accuracy * 100) | 0}% match`, W / 2, H * 0.2 + 34, 18, 0.55);
    if (combo) text(`${combo} midair bonus`, W / 2, H * 0.2 + 58, 15, 0.5);
    // Pulse the prompt so it reads as waiting on you, not as a stuck screen.
    const breathe = 0.55 + 0.35 * Math.sin(nowMs / 320);
    text(
      grew ? "tap to add a note" : "tap to hear it again",
      W / 2,
      H * 0.2 + (combo ? 96 : 78),
      19,
      breathe
    );
  }

  if (round <= 1 && phase === CALL && now - (phaseAt - BEAT * LEADIN) < 6) {
    text("sound on?", W / 2, H - 44, 15, 0.4);
  }

  text(`${score}`, W / 2, 82, 22, 0.7);
  text(`${seq.length} notes   best ${best}`, W / 2, H - 18, 14, 0.35);
}

resize();
requestAnimationFrame(frame);
