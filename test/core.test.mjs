import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "../src/core.js";

// ---------------------------------------------------------------- share links
// Every one of these round-trips is a link somebody could have already sent.

test("a run round-trips through its link", () => {
  const run = {
    seq: [0, 3, 1, 4],
    offs: [0, 1, 2, 3],
    hgt: [0, 0, 0, 0],
    taps: [{ i: 0, dt: 0 }, { i: 3, dt: 0.75 }, { i: 1, dt: 1.5 }],
  };
  const back = C.decodeRun(C.encodeRun(run));
  assert.deepEqual(back.seq, run.seq);
  assert.deepEqual(back.offs, run.offs);
  assert.equal(back.taps.length, 3);
  assert.equal(back.taps[1].i, 3);
  assert.ok(Math.abs(back.taps[1].dt - 0.75) < 0.02, "tap time survives 20ms quantising");
});

test("irregular rhythm survives the link", () => {
  const run = { seq: [1, 2, 3, 4], offs: [0, 0.5, 2.5, 3.5], hgt: [0, 0, 0, 0], taps: [] };
  assert.deepEqual(C.decodeRun(C.encodeRun(run)).offs, [0, 0.5, 2.5, 3.5]);
});

test("heights ride along, and mark the run as hardcore", () => {
  const run = { seq: [0, 1, 2], offs: [0, 1, 2], hgt: [1, 0, 1], taps: [] };
  const back = C.decodeRun(C.encodeRun(run));
  assert.deepEqual(back.hgt, [1, 0, 1]);
  assert.equal(back.hardcore, true, "a pattern carrying heights arrives as hardcore");
});

test("a run with no heights is not hardcore, and adds no field", () => {
  const run = { seq: [0, 1], offs: [0, 1], hgt: [0, 0], taps: [] };
  assert.equal(C.encodeRun(run).split(".").length, 3, "no trailing height field");
  assert.equal(C.decodeRun(C.encodeRun(run)).hardcore, false);
});

test("a jam link is a performance, not a challenge", () => {
  const taps = [{ i: 0, dt: 0 }, { i: 4, dt: 0.4 }, { i: 2, dt: 1.1 }];
  const back = C.decodeRun(C.encodeJam(taps));
  assert.equal(back.jam, true);
  assert.equal(back.seq.length, 0, "no phrase to match");
  assert.equal(back.taps.length, 3);
});

test("junk links are refused rather than half-loaded", () => {
  for (const bad of ["", "x", "9.1.", "01.111.", "j.", "j.0", "012.1.", "..", "07.1."]) {
    assert.equal(C.decodeRun(bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
});

// ------------------------------------------------------------ difficulty ramp
test("the first six notes are straight quarter notes", () => {
  for (let len = 2; len < 7; len++)
    for (const r of [0, 0.25, 0.5, 0.75, 0.99])
      assert.equal(C.nextGap(len, r), 1, `len ${len} must stay on the beat`);
});

test("hardcore pulls the rhythm schedule forward", () => {
  const draws = Array.from({ length: 40 }, (_, i) => i / 40);
  const seen = (len, hard) => new Set(draws.map((r) => C.nextGap(len, r, hard)));
  assert.deepEqual([...seen(5, false)], [1], "normal is still straight at 5 notes");
  assert.ok(seen(5, true).has(2), "hardcore has holds by 5");
  assert.ok(!seen(5, true).has(0.5), "but not off-beats yet");
  assert.ok(seen(7, true).has(0.5), "hardcore has off-beats by 7");
  assert.ok(!seen(7, false).has(0.5), "normal does not until 10");
});

test("held notes arrive before off-beats, never the other way round", () => {
  const mid = new Set();
  const late = new Set();
  for (let i = 0; i < 40; i++) {
    mid.add(C.nextGap(8, i / 40));
    late.add(C.nextGap(12, i / 40));
  }
  assert.ok(mid.has(2), "two-beat holds by 7 notes");
  assert.ok(!mid.has(0.5), "no off-beats before 10 notes");
  assert.ok(late.has(0.5), "off-beats by 10 notes");
});

// ------------------------------------------------------------- timing window
test("straight phrases keep the full window", () => {
  assert.ok(Math.abs(C.windowFor([0, 1, 2, 3]) - C.WINDOW) < 0.001);
});

test("an off-beat tightens the window so neighbours can't overlap", () => {
  const w = C.windowFor([0, 1, 1.5, 2.5]);
  assert.ok(w < C.WINDOW, "window must shrink");
  assert.ok(w < (0.5 * C.BEAT) / 2, "and stay inside half the tightest gap");
});

// -------------------------------------------------------------------- judging
test("a tap claims the nearest unclaimed slot", () => {
  const offs = [0, 1, 2];
  const judged = [-1, -1, -1];
  const w = C.windowFor(offs);
  assert.equal(C.judgeSlot(offs, judged, 0, 1.02 * C.BEAT, w).k, 1);
});

test("an already-judged slot is skipped, not stolen", () => {
  const offs = [0, 1, 2];
  const judged = [1, -1, -1];
  const got = C.judgeSlot(offs, judged, 0, 0.05, C.windowFor(offs));
  assert.notEqual(got.k, 0, "slot 0 is spent");
});

test("a tap outside the window is a stray, not a hijack of the next note", () => {
  const offs = [0, 1, 2];
  const w = C.windowFor(offs);
  // Half a beat late: too far for slot 0, and it must NOT be handed slot 1.
  assert.equal(C.judgeSlot(offs, [-1, -1, -1], 0, 0.5 * C.BEAT, w).k, -1);
});

test("timing score steps down by tier and floors at zero", () => {
  const w = C.WINDOW;
  assert.equal(C.timingScore(0, w), 1);
  assert.equal(C.timingScore(w * 0.5, w), 0.6, "mid-window is GOOD, a named band");
  assert.equal(C.timingScore(w * 2, w), 0, "never negative");
});

// -------------------------------------------------------------------- scoring
test("heat builds through the phrase instead of maxing on note one", () => {
  const early = C.heat([1, -1, -1, -1], 4);
  const late = C.heat([1, 1, 1, 1], 4);
  assert.ok(early < late, "one perfect note must not max the spectacle");
  assert.ok(Math.abs(late - 1) < 1e-9, "a clean phrase reaches full heat");
});

test("accuracy counts unplayed notes as missed", () => {
  // The opener carries half weight, so one note out of two is a third, not a half.
  assert.ok(Math.abs(C.accuracyOf([1, -1], 2) - 1 / 3) < 1e-9);
  assert.equal(C.accuracyOf([-1, -1], 2), 0);
});

test("the multiplier grows with the streak and is capped", () => {
  assert.equal(C.multFor(0), 1);
  assert.equal(C.multFor(2), 2);
  assert.equal(C.multFor(99), 5, "capped at x5");
});

// -------------------------------------------------------------------- physics
const SCREENS = [
  ["desktop", 900, 650],
  ["ipad", 1024, 768],
  ["iphone", 390, 740],
  ["wide", 1440, 900],
];

test("flight time is identical on every screen", () => {
  const ref = C.flightFor(0.5);
  for (const [name, W, H] of SCREENS) {
    const p = C.launchParams(H, W / 6, 0.5);
    assert.ok(Math.abs(p.flight - ref) < 1e-9, `${name} flight drifted`);
  }
});

test("an arc covers the same number of unicorns on every screen", () => {
  for (const [name, W, H] of SCREENS) {
    const slot = W / 6;
    assert.ok(
      Math.abs(C.launchParams(H, slot, 1).reach / slot - 4) < 1e-9,
      `${name} reach/slot drifted -- this is what made phones bounce off the walls`
    );
  }
});

test("gravity is derived so the arc actually lasts its flight time", () => {
  const p = C.launchParams(650, 150, 0.7);
  // apex at flight/2, back to ground at flight
  assert.ok(Math.abs(-p.vy0 / p.g - p.flight / 2) < 1e-6);
});

test("there are exactly two heights, and holding longer adds nothing", () => {
  const H = 650;
  const slot = 150;
  const low = C.apex(H, slot, 0.5, 0);
  const tap = C.apex(H, slot, 0.5, 0.05);
  const edge = C.apex(H, slot, 0.5, C.HOLD_HIGH - 0.01);
  const high = C.apex(H, slot, 0.5, C.HOLD_HIGH + 0.01);
  const longer = C.apex(H, slot, 0.5, 2);

  assert.ok(Math.abs(tap - low) < 1, "a quick tap must not overshoot the low arc");
  assert.ok(Math.abs(edge - low) < 1, "just under the threshold is still low");
  assert.ok(Math.abs(longer - high) < 1, "holding longer adds no extra height");
  assert.ok(high > low * 1.5, "the two heights must be obviously different");
});

test("the high apex is the canonical one, so the herd's demo is matchable", () => {
  const H = 650;
  const high = C.apex(H, 150, 0.5, 1);
  assert.ok(Math.abs(high - H * C.HIGH_F) < 4, "player high must equal the herd's high");
});

test("heights hold their shape across screens", () => {
  for (const [name, W, H] of SCREENS) {
    const r = C.apex(H, W / 6, 0.5, 1) / C.apex(H, W / 6, 0.5, 0);
    assert.ok(Math.abs(r - 1.807) < 0.02, `${name} height ratio drifted (${r.toFixed(3)})`);
  }
});

test("note height never depends on how the run is going", () => {
  // The herd played at last round's accuracy while the player played at this round's
  // running heat, so the demo was tall and the answer small. Height is information;
  // it must be one number.
  assert.equal(C.NOTE_POWER, 0.5);
  const H = 650;
  const herdLow = C.apex(H, 150, C.NOTE_POWER, 0);
  const playerLow = C.apex(H, 150, C.NOTE_POWER, 0.05);
  const herdHigh = C.apex(H, 150, C.NOTE_POWER, 1);
  const playerHigh = C.apex(H, 150, C.NOTE_POWER, 0.4);
  assert.ok(Math.abs(herdLow - playerLow) < 1, "low notes must match");
  assert.ok(Math.abs(herdHigh - playerHigh) < 1, "high notes must match");
});

// --------------------------------------------------------------- timing tiers
test("tiers are named bands, not a sliding number", () => {
  const w = C.WINDOW;
  assert.equal(C.tierFor(0, w).name, "PERFECT");
  assert.equal(C.tierFor(w * 0.3, w).name, "GREAT");
  assert.equal(C.tierFor(w * 0.5, w).name, "GOOD");
  assert.equal(C.tierFor(w * 0.9, w).name, "", "the last band is named by direction");
  assert.equal(C.tierFor(w * 1.2, w), null, "outside the window is not this note's tap");
});

test("tiers scale with the window so off-beat phrases stay playable", () => {
  const tight = C.windowFor([0, 1, 1.5]); // contains a half beat
  // The same fraction of a tighter window is still PERFECT, just in less time.
  assert.equal(C.tierFor(tight * 0.1, tight).name, "PERFECT");
  assert.ok(tight * 0.17 < C.WINDOW * 0.17, "and PERFECT is genuinely harder to hit");
});

test("credit falls with the tier and never goes negative", () => {
  const w = C.WINDOW;
  const c = (f) => C.timingScore(w * f, w);
  assert.ok(c(0) > c(0.3) && c(0.3) > c(0.5) && c(0.5) > c(0.9));
  assert.equal(c(2), 0);
});

test("a two-note phrase can't pass on the free first note alone", () => {
  // The opener is free of timing judgement; it must not also be free of consequence.
  const anchorOnly = C.accuracyOf([1, -1], 2);
  assert.ok(anchorOnly < 0.5, `tap-once-and-advance must fail (got ${anchorOnly.toFixed(2)})`);
  assert.ok(C.accuracyOf([1, 1], 2) > 0.99, "playing both still scores full marks");
});

test("the wrong opening note still costs you", () => {
  assert.ok(C.accuracyOf([0, 1], 2) < C.accuracyOf([1, 1], 2));
});
