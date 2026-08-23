# js13k 2026

Game jam entry. Hard constraint: **the zipped build must be ≤ 13312 bytes.** Check with
`npm run party` before assuming anything fits.

## The game: UNICORN STORM

Call-and-response rhythm game. The herd plays a phrase on the beat; the player plays it
back. Five unicorns, one pentatonic note each (C D E G A) — so any tap order sounds
musical, which matters because players fail constantly in a memory game.

Load-bearing decisions, so they don't get undone by accident:

- **The row never moves.** Recall is positional ("third from the left"), so each note
  spawns a flying *copy* that arcs, bounces, and falls through the floor. Originals stay put.
- **Everything is scheduled against `AudioContext.currentTime`** with a ~120ms lookahead.
  `setTimeout` drifts and drift is fatal here. Visuals chase the audio clock, never the reverse.
- **`flourish` (0..1) drives all spectacle** — arc height, ribbon width, spark count, sky
  brightness. It updates per judged note, not at end of round, so escalation is felt live.
- Pitch belongs to the unicorn, not to tap height. Recall is one axis: which, and when.
  Tap-height-sets-pitch was built and deliberately parked — see the planning notes.

Design notes live **outside this repo** in `../js13k2026-plan/`.

## Tests

`npm test` runs unit tests, builds, and smoke-tests the packed build. Run it before
pushing -- push auto-deploys.

- `src/core.js` holds the pure logic: share-link encoding, the difficulty ramp, timing
  windows, scoring, and the launch/apex maths. It has no canvas, audio or DOM, so
  `node --test` can assert on it directly. **`src/index.ts` imports it and must never
  re-implement any of it** -- a second copy is a copy that drifts, and that is exactly
  how the herd and the player ended up on different leap formulas.
- `test/core.test.mjs` covers what has actually broken: link round-trips (including
  heights and jam links), the ramp schedule, window tightening for off-beats, nearest
  unclaimed slot selection, stray taps, heat weighting, and the physics invariants --
  identical flight time and reach/slot on every screen, exactly two heights, and the
  player's high apex equalling the herd's.
- `scripts/smoke.js` drives `dist/index.html` in headless Chrome through every screen.
  Unit tests cannot catch a bundle that throws on load, and `webpack.prod` mangles
  property names, so a build can pass the size check and still be dead on arrival.

## Layout

- `src/index.ts` — game code (entry point)
- `src/index.html` — the shell; CSS lives inline here
- `assets/` — images/audio, inlined into the bundle as data URIs at build time
- `scripts/shot.js` — headless-Chrome screenshot + input + error harness (see below)

## Remote workflow (iPad + rootshell)

Dev happens over SSH from the iPad into `chopper`, inside a tmux session. Two things
follow from that:

1. **Run `npm start` inside tmux.** The iPad sleeping drops SSH, but tmux keeps the
   server alive — reattach and it's still going. Don't run it outside tmux.
2. **There is no JS console on the iPad.** A TypeScript runtime error is otherwise
   invisible — the canvas just goes blank. `npm run shot` surfaces those errors as text.

### The loop

```
npm start                    # dev server, foreground, Ctrl-C to stop
# edit src/index.ts in rootshell
# Safari on the iPad auto-reloads -- live reload is on
npm run shot                 # capture what the page actually rendered + any errors
```

Viewing the game on the iPad — Tailscale, so it works off your home network too:

    http://100.68.161.125:8081/          (chopper's tailscale IP)
    http://chopper.taildd40e8.ts.net:8081/

Port **8081 is pinned** in `webpack.dev.cjs`. Don't unpin it — webpack silently walks to
the next free port when one is taken, which would break the iPad bookmark.

### Screenshot harness

`scripts/shot.js` drives headless Chrome over the DevTools Protocol. No dependencies —
it uses Node 22's native `WebSocket`, deliberately, to keep the repo light.

```
npm run shot                                          # shots/shot.png
npm run shot -- --keys "ArrowRight:600"               # hold right 600ms, then capture
npm run shot -- --keys "ArrowRight+ArrowUp:400"       # chord with +
npm run shot -- --keys "Space:80,ArrowLeft:300"       # sequence with ,
npm run shot -- --size 1024x768 --out shots/ipad.png  # emulate the iPad viewport
```

It prints everything the page logged and **exits non-zero on an uncaught error**, so it
works as a smoke test. Network 404s (favicon) are ignored on purpose.

For Claude: this is how you verify a change actually works. Take a shot, then read the
PNG — don't claim a rendering or input change is fixed without looking at it.

## Build

- `npm run build` — inlined `dist/index.html` + `dist/report.html` (bundle analyzer, for
  finding what's eating the budget)
- `npm run party` — build, Roadroller-pack, zip to `zipped/game.zip`, assert ≤ 13312 bytes

Baseline starter measures ~1.5kB zipped.

## Gotchas

- `chalk` and `terser-webpack-plugin` are used by the build but were previously undeclared
  — they only resolved via transitive hoisting. They're now explicit in `devDependencies`;
  don't remove them.
- If port 8081 is refused, something is already holding it. Find it with
  `ss -ltnp | grep 8081` rather than letting webpack drift to another port.
- This repo has **no git remote**. History was re-initialized so it's detached from the
  starter. Add your own `origin` when you create the GitHub repo.
