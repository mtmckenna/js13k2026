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

const BPM = 96;
const BEAT = 60 / BPM;
const WINDOW = 0.3; // how far off the beat still counts, in seconds
const REST = 2; // beats of silence between the call and your turn

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
let len = 3;
let round = 0;
let best = 0;

let schedIdx = 0; // notes handed to the audio clock
let visIdx = 0; // notes animated
let clickIdx = 0;

let judged: number[] = []; // per-slot score, -1 = not yet attempted
let accuracy = 0; // last round
let flourish = 0; // 0..1 -- drives how big everything gets
let message = "";

function newRound(now: number) {
  seq = [];
  for (let i = 0; i < len; i++) seq.push((Math.random() * COUNT) | 0);
  judged = seq.map(() => -1);
  schedIdx = visIdx = clickIdx = 0;
  phase = CALL;
  phaseAt = now + BEAT * 1.5; // lead-in so the first note isn't a surprise
  flourish = accuracy; // the herd shows off in proportion to how you last did
  message = "";
  round++;
}

function respondStart() {
  return phaseAt + (seq.length - 1 + REST) * BEAT;
}

// --- leaping -------------------------------------------------------------

function leap(i: number, power: number) {
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
    newRound(ac.currentTime);
    return;
  }
  if (ac.state === "suspended") ac.resume();
  const now = ac.currentTime;

  if (phase !== RESPOND) {
    // Free play outside your turn -- noodling should always be allowed.
    note(NOTES[i], herd[i].voice, now, 0.2);
    leap(i, 0.35);
    return;
  }

  note(NOTES[i], herd[i].voice, now, 0.22);

  // Which beat was this aimed at?
  const k = Math.round((now - respondStart()) / BEAT);
  if (k < 0 || k >= seq.length || judged[k] >= 0) {
    leap(i, 0.3); // stray tap: it still leaps, just joylessly
    flourish = Math.max(0, flourish - 0.15);
    return;
  }

  const off = Math.abs(now - (respondStart() + k * BEAT));
  const timing = Math.max(0, 1 - off / WINDOW);
  const right = seq[k] === i;
  judged[k] = right ? timing : 0;

  // Running accuracy over what's been attempted so far -- this is what makes the
  // display escalate as the player closes in on a perfect round.
  let sum = 0;
  let n = 0;
  for (const j of judged) if (j >= 0) (sum += j), n++;
  flourish = n ? sum / n : 0;

  leap(i, right ? 0.35 + flourish : 0.2);
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
    if (now >= respondStart() - BEAT * 0.5) {
      phase = RESPOND;
      message = "";
    }
  } else if (phase === RESPOND) {
    if (now > respondStart() + (seq.length - 1) * BEAT + WINDOW) {
      let sum = 0;
      for (const j of judged) sum += Math.max(0, j);
      accuracy = sum / seq.length;
      phase = GRADE;
      phaseAt = now;

      if (accuracy > 0.98) {
        message = "PERFECT";
        for (let i = 0; i < COUNT; i++) {
          burst(slot * (i + 1), groundY - H * 0.3 * Math.random() - 60, HUES[i], HUES[(i + 2) % COUNT], 1);
        }
      } else if (accuracy >= 0.6) {
        message = "NICE";
      } else {
        message = "AGAIN";
      }
      if (accuracy >= 0.6) {
        if (round > best) best = round;
        len = Math.min(len + 1, 8);
      } else {
        len = Math.max(3, len - 1);
      }
    }
  } else if (phase === GRADE) {
    if (now > phaseAt + BEAT * 3) newRound(now);
  }

  // Metronome runs through every phase so the pulse never drops.
  if (phase !== TITLE) {
    for (;;) {
      const at = phaseAt + clickIdx * BEAT;
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

  if (glow > 0.01) {
    ctx.fillStyle = `hsla(${hue},100%,70%,${glow * 0.3})`;
    ctx.beginPath();
    ctx.arc(0, 0, 24 + glow * 12, 0, 6.284);
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
      burst((a.x + b.x) / 2, (a.y + b.y) / 2, a.hue, b.hue, 0.3 + flourish);
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

  ctx.fillStyle = "rgba(255,255,255,.09)";
  ctx.fillRect(0, groundY + 16, W, H);

  for (const f of flyers) drawUnicorn(f.x, f.y - 14, f.hue, f.vx, f.vy, f.glow);

  for (const u of herd) {
    u.lit = Math.max(0, u.lit - dt * 1.6);
    u.bob += dt * 2.2;
    drawUnicorn(u.homeX, groundY - 14 - Math.abs(Math.sin(u.bob)) * 3, u.hue, 1, 0, u.lit);
  }

  // --- hud ---
  if (phase === TITLE) {
    text("ECHO", W / 2, H * 0.36, Math.min(74, W / 7), 0.95);
    text("the herd plays a phrase. play it back.", W / 2, H * 0.36 + 46, Math.min(19, W / 26), 0.6);
    text("tap a unicorn to begin", W / 2, H * 0.36 + 78, Math.min(17, W / 30), 0.45);
    return;
  }

  // Sequence dots: one per note, so you can see how long the phrase is and,
  // during your turn, which beat you're on.
  const dotY = 42;
  const spread = Math.min(34, W / (seq.length + 3));
  const x0 = W / 2 - ((seq.length - 1) * spread) / 2;
  const cursor = phase === RESPOND ? Math.round((now - respondStart()) / BEAT) : -1;
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

  const label = phase === CALL ? "listen" : phase === RESPOND ? "your turn" : message;
  const big = phase === GRADE && message === "PERFECT";
  text(label, W / 2, H * 0.2, big ? 46 : 22, big ? 0.95 : 0.55);
  text(`round ${round}   best ${best}`, W / 2, H - 18, 14, 0.35);
}

resize();
requestAnimationFrame(frame);
