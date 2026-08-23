// Pure game logic, deliberately free of canvas, audio and DOM so it can be imported
// and asserted on directly by node --test. Everything here was, at some point, a bug.

export const COUNT = 5;
export const BPM = 80;
export const BEAT = 60 / BPM;
export const WINDOW = 0.36;
export const HOLD_HIGH = 0.16; // hold longer than this and the note becomes a high leap
export const HIGH_F = 0.667; // canonical high apex, as a fraction of screen height

// --- difficulty ramp ---------------------------------------------------------
// Straight quarter notes for a long time; held notes (easier, more room) before
// off-beats. `r` is the random draw, passed in so this is testable.
// `hard` pulls the whole schedule forward. Hardcore was only ever one axis harder --
// heights -- while its rhythm ramp was identical to normal, so a fresh hardcore run
// opened on straight quarter notes exactly like an easy one.
export function nextGap(len, r, hard) {
  const holds = hard ? 4 : 7;
  const offs = hard ? 6 : 10;
  if (len < holds) return 1;
  const pool = len < offs ? [1, 1, 1, 1, 2] : [1, 1, 1, 1, 2, 2, 0.5];
  return pool[Math.min(pool.length - 1, Math.floor(r * pool.length))];
}

// A half-beat gap is 375ms, so a flat +/-360ms window would swallow its neighbour.
// Never let the window exceed 48% of the tightest gap in the phrase.
export function windowFor(offs) {
  let min = 9;
  for (let i = 1; i < offs.length; i++) min = Math.min(min, offs[i] - offs[i - 1]);
  return Math.min(WINDOW, min * BEAT * 0.48);
}

// --- scoring -----------------------------------------------------------------
// Named tiers rather than a sliding number. A continuous ramp gave no vocabulary
// between PERFECT and a raw millisecond count, so "late 120ms" told you nothing about
// whether that was decent. Bands are fractions of the window, not fixed times, so a
// phrase with off-beats (half the window) stays playable.
export const TIERS = [
  { at: 0.17, name: "PERFECT", credit: 1 },
  { at: 0.36, name: "GREAT", credit: 0.85 },
  { at: 0.67, name: "GOOD", credit: 0.6 },
  { at: 1, name: "", credit: 0.3 }, // named by direction instead: "early"/"late"
];

export function tierFor(off, win) {
  const f = off / win;
  for (const t of TIERS) if (f <= t.at) return t;
  return null; // outside the window entirely -- not this note's tap
}

export function timingScore(off, win) {
  const t = tierFor(off, win);
  return t ? t.credit : 0;
}

// Weighted by depth into the phrase as well as accuracy: accuracy alone maxes out
// on the first correct note and leaves the spectacle nowhere to build.
export function heat(judged, len) {
  let sum = 0;
  let n = 0;
  for (const j of judged) if (j >= 0) (sum += j), n++;
  if (!n) return 0;
  return (sum / n) * (0.3 + 0.7 * (n / len));
}

// The opening note is free of TIMING judgement (it sets the beat), so counting it as
// a whole note let a two-note phrase pass on the gimme alone -- tap once, advance.
// It still counts, at half weight, so playing the wrong first note is not free either.
export const ANCHOR_W = 0.5;

export function accuracyOf(judged, len) {
  let sum = 0;
  let w = 0;
  for (let i = 0; i < len; i++) {
    const wi = i === 0 ? ANCHOR_W : 1;
    sum += Math.max(0, judged[i]) * wi;
    w += wi;
  }
  return w ? sum / w : 0;
}

export function multFor(streak) {
  return Math.min(5, 1 + streak * 0.5);
}

// Slots are unevenly spaced once rhythm is in play, so find the nearest UNCLAIMED
// one rather than dividing by the beat. Returns -1 when nothing is close enough.
export function judgeSlot(offs, judged, turnAt, now, win) {
  let k = -1;
  let best = 1e9;
  for (let j = 0; j < offs.length; j++) {
    if (judged[j] >= 0) continue;
    const d = Math.abs(now - (turnAt + offs[j] * BEAT));
    if (d < best) {
      best = d;
      k = j;
    }
  }
  return best > win ? { k: -1, off: best } : { k, off: best };
}

// Height is INFORMATION now (tap vs hold), so it must never depend on how well the
// run is going. It used to: the herd played at last round's accuracy while the player
// played at this round's running heat, which starts near zero -- so the herd showed
// tall arcs and your answers came out small. Spectacle still escalates, through ribbon
// width, glow, sparks, sky and lightning.
export const NOTE_POWER = 0.5;

// --- physics -----------------------------------------------------------------
// Flight time depends on the NOTE, never on the screen: derived from sqrt(peak/G) it
// ran 18% longer on a tall display, which moved every crossing against a fixed beat.
export function flightFor(power) {
  return 0.95 + power * 0.42;
}

export function launchParams(H, slot, power) {
  const peak = H * (0.2 + power * 0.34);
  const flight = flightFor(power);
  return {
    peak,
    flight,
    g: (8 * peak) / (flight * flight),
    vy0: -(4 * peak) / flight,
    // Reach in HERD-SPACING units so an arc covers the same number of unicorns
    // whatever the aspect ratio.
    reach: slot * (2 + power * 2),
  };
}

// Integrates exactly as the game loop does, including the one-shot snap. Returns the
// apex in pixels above the ground.
export function apex(H, slot, power, holdSec, step = 1 / 240) {
  const p = launchParams(H, slot, power);
  let vy = p.vy0;
  let y = 0; // height above ground
  let top = 0;
  let t = 0;
  let armed = holdSec > 0;
  while (t < p.flight * 1.6 && (y > 0 || t < step * 2)) {
    if (armed && t >= HOLD_HIGH) {
      armed = false;
      if (holdSec >= HOLD_HIGH) {
        const rise = H * HIGH_F - y;
        if (rise > 0) {
          const v = Math.sqrt(2 * p.g * rise);
          if (v > -vy) vy = -v;
        }
      }
    }
    vy += p.g * step;
    y -= vy * step;
    top = Math.max(top, y);
    t += step;
  }
  return top;
}

// --- share links -------------------------------------------------------------
// A run is {seq, offs, hgt, taps}. Notes as digits, gaps as one char, taps as a digit
// plus two base36 chars of 20ms units, heights as an optional trailing field.
export function encodeTaps(list) {
  let t = "";
  for (const p of list) {
    const u = Math.min(1295, Math.max(0, Math.round(p.dt * 50)));
    t += p.i + ("0" + u.toString(36)).slice(-2);
  }
  return t;
}

export function decodeTaps(t) {
  const out = [];
  for (let i = 0; i + 2 < t.length; i += 3) {
    const u = +t[i];
    if (!(u >= 0 && u < COUNT)) return null;
    out.push({ i: u, dt: parseInt(t.slice(i + 1, i + 3), 36) / 50 });
  }
  return out;
}

export function encodeRun(run) {
  let g = "";
  for (let i = 1; i < run.offs.length; i++) {
    const d = run.offs[i] - run.offs[i - 1];
    g += d === 0.5 ? "0" : d === 2 ? "2" : "1";
  }
  const h = run.hgt && run.hgt.some((v) => v) ? "." + run.hgt.join("") : "";
  return run.seq.join("") + "." + g + "." + encodeTaps(run.taps || []) + h;
}

export function encodeJam(taps) {
  return "j." + encodeTaps(taps);
}

export function decodeRun(code) {
  try {
    if (code.slice(0, 2) === "j.") {
      const tp = decodeTaps(code.slice(2));
      if (!tp || tp.length < 2) return null;
      return { jam: true, seq: [], offs: [], hgt: [], taps: tp };
    }
    const [a, g, t, h] = code.split(".");
    if (!a || a.length < 2) return null;
    const seq = a.split("").map(Number);
    if (seq.some((v) => !(v >= 0 && v < COUNT))) return null;
    const offs = [0];
    for (let i = 0; i < g.length; i++)
      offs.push(offs[i] + (g[i] === "0" ? 0.5 : g[i] === "2" ? 2 : 1));
    if (offs.length !== seq.length) return null;
    const taps = decodeTaps(t || "");
    if (!taps) return null;
    const hgt = h ? h.split("").map(Number) : seq.map(() => 0);
    return { jam: false, seq, offs, hgt, taps, hardcore: hgt.some((v) => v) };
  } catch (e) {
    return null;
  }
}
