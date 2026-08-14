// Prototype: tap a unicorn, it leaps an arc and sounds a note.
// No scoring, no memory game yet -- this exists purely to answer "is this fun?"

// C D E G A -- major pentatonic. No interval in it can sound wrong, so any order
// the player taps still sounds musical. Matters a lot once they're playing badly.
const NOTES = [261.63, 293.66, 329.63, 392.0, 440.0];
const HUES = [350, 35, 120, 205, 280];
const COUNT = NOTES.length;

const canvas: HTMLCanvasElement = document.createElement("canvas");
const ctx: CanvasRenderingContext2D = canvas.getContext("2d");
document.body.appendChild(canvas);

let W = 0;
let H = 0;
let groundY = 0;
let slot = 0;

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

interface Unicorn {
  homeX: number;
  hue: number;
  freq: number;
  arc: number; // 0..1 through the leap, -1 when idle
  span: number; // signed horizontal distance travelled
  peak: number;
  bob: number;
  trot: number; // 0..1 walking back to the home slot, -1 when not
  ribbon: Ribbon;
}

const herd: Unicorn[] = [];
for (let i = 0; i < COUNT; i++) {
  herd.push({
    homeX: 0,
    hue: HUES[i],
    freq: NOTES[i],
    arc: -1,
    // Higher note -> bigger, wider arc. The trajectory is derived from the pitch,
    // so the leap reads as a distinct silhouette per unicorn without extra input.
    span: 0,
    peak: 0,
    bob: Math.random() * 6.28,
    trot: -1,
    ribbon: null,
  });
}

// One ribbon per leap, stroked as a path. Drawing discrete dots reads as beads;
// a stroked polyline reads as a rainbow band.
interface Ribbon {
  hue: number;
  pts: number[];
  age: number;
}
const ribbons: Ribbon[] = [];

// --- audio ---------------------------------------------------------------
// Created lazily inside a real gesture: iOS Safari refuses to start otherwise.
let ac: AudioContext;

function note(freq: number) {
  if (!ac) ac = new (window.AudioContext || (window as any).webkitAudioContext)();
  if (ac.state === "suspended") ac.resume();

  const t = ac.currentTime;
  const gain = ac.createGain();
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.22, t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0005, t + 1.1);
  gain.connect(ac.destination);

  // Two slightly detuned voices: cheap way to sound like an instrument
  // rather than a test tone.
  for (let i = 0; i < 2; i++) {
    const osc = ac.createOscillator();
    osc.type = i ? "sine" : "triangle";
    osc.frequency.value = freq * (i ? 2.005 : 1);
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + 1.2);
  }
}

// --- input ---------------------------------------------------------------

function leap(i: number) {
  const u = herd[i];
  if (u.arc >= 0) return; // already airborne
  const rank = i / (COUNT - 1);
  u.peak = H * (0.22 + rank * 0.22);
  // Span must scale with PEAK, not with slot width. Tied to slot the parabola comes
  // out tall and narrow -- a vertical line with a kink, not an arc.
  // Roughly 1.7x wide as high is what reads as a rainbow.
  const dir = u.homeX <= W / 2 ? 1 : -1;
  u.span = dir * u.peak * 1.7;
  u.arc = 0;
  u.trot = -1;
  u.ribbon = { hue: u.hue, pts: [], age: 0 };
  ribbons.push(u.ribbon);
  note(u.freq);
}

canvas.addEventListener("pointerdown", (e: PointerEvent) => {
  e.preventDefault();
  const i = Math.min(COUNT - 1, Math.max(0, Math.round(e.clientX / slot) - 1));
  leap(i);
});

addEventListener("keydown", (e: KeyboardEvent) => {
  const i = "12345".indexOf(e.key);
  if (i >= 0) leap(i);
});

addEventListener("resize", resize);

// --- render --------------------------------------------------------------

function drawUnicorn(x: number, y: number, hue: number, vx: number, vy: number) {
  ctx.save();
  ctx.translate(x, y);
  // Point along the direction of travel, then mirror vertically when heading left
  // so the unicorn banks instead of flying upside down.
  ctx.rotate(Math.atan2(vy, vx));
  if (vx < 0) ctx.scale(1, -1);

  // Saturated body, not near-white: the body colour IS the unicorn's identity, and
  // the player has to tell five of them apart at a glance.
  ctx.fillStyle = `hsl(${hue},72%,66%)`;
  ctx.beginPath();
  ctx.ellipse(0, 0, 15, 10, 0, 0, 6.284);
  ctx.fill();

  // legs
  ctx.strokeStyle = `hsl(${hue},62%,58%)`;
  ctx.lineWidth = 3.5;
  ctx.lineCap = "round";
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(-9 + i * 6, 6);
    ctx.lineTo(-11 + i * 6, 15);
    ctx.stroke();
  }

  // head + horn
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

  // Mane stays within ~30 deg of the body hue. A full-rainbow mane on every unicorn
  // makes all five read as the same creature.
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

let last = 0;
function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#141033");
  sky.addColorStop(1, "#2b1b47");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // Ribbons, additive so crossings bloom into white where colors overlap.
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
    const a = 1 - r.age / 2.2;
    ctx.beginPath();
    ctx.moveTo(r.pts[0], r.pts[1]);
    for (let p = 2; p < r.pts.length; p += 2) ctx.lineTo(r.pts[p], r.pts[p + 1]);
    // Wide soft pass then a bright core -- a two-stroke glow, no shadowBlur cost.
    ctx.strokeStyle = `hsla(${r.hue},95%,60%,${a * 0.28})`;
    ctx.lineWidth = 16 * a + 3;
    ctx.stroke();
    ctx.strokeStyle = `hsla(${r.hue},100%,78%,${a * 0.75})`;
    ctx.lineWidth = 5 * a + 1;
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";

  ctx.fillStyle = "rgba(255,255,255,.09)";
  ctx.fillRect(0, groundY + 16, W, H);

  for (const u of herd) {
    let x = u.homeX;
    let y = groundY;
    let vx = 1;
    let vy = 0;

    if (u.arc >= 0) {
      u.arc += dt / 0.95;
      if (u.arc >= 1) {
        u.arc = -1;
        u.trot = 0; // landed away from home; walk back
      } else {
        const t = u.arc;
        // x travels one way only. Sending it out and back with sin() makes the
        // return retrace the outbound path, which draws a straight line, not an arc.
        x = u.homeX + u.span * t;
        y = groundY - 4 * u.peak * t * (1 - t);
        vx = u.span;
        vy = -4 * u.peak * (1 - 2 * t); // d/dt of the parabola
        u.ribbon.pts.push(x, y + 4);
      }
    } else if (u.trot >= 0) {
      // Trot home so the row never reorders -- positional recall depends on it.
      u.trot += dt / 0.45;
      if (u.trot >= 1) u.trot = -1;
      const t = Math.min(u.trot, 1);
      x = u.homeX + u.span * (1 - t);
      y = groundY - Math.abs(Math.sin(t * 12)) * 4;
      vx = -u.span; // face the way it's walking
    } else {
      u.bob += dt * 2.2;
      y = groundY - Math.abs(Math.sin(u.bob)) * 3;
    }

    drawUnicorn(x, y - 14, u.hue, vx, vy);
  }

  last = now;
}

resize();
requestAnimationFrame(frame);
