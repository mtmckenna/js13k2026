#!/usr/bin/env node
// End-to-end check of the SHIPPED build. Unit tests can't catch a bundle that throws
// on load: webpack.prod mangles property names, so a build can pass the size check
// and still be dead on arrival. This drives dist/index.html in a real browser.
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

const MAX = 13312;
const dist = process.cwd() + "/dist/index.html";
const zip = process.cwd() + "/zipped/game.zip";
let failed = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    console.log(`  FAIL  ${name}\n        ${e.message.split("\n")[0]}`);
    failed++;
  }
}

// shot.js exits non-zero on any uncaught page error, so it doubles as the assertion.
function drive(label, args) {
  execFileSync("node", ["scripts/shot.js", "--url", "file://" + dist, "--out", "/dev/null", ...args], {
    stdio: "pipe",
  });
}

console.log("smoke: the packed build");
check("dist/index.html exists", () => {
  if (!existsSync(dist)) throw new Error("run npm run party first");
});
check("zip is under 13k", () => {
  const n = statSync(zip).size;
  if (n > MAX) throw new Error(`${n} bytes, over by ${n - MAX}`);
  console.log(`        ${statSync(zip).size} bytes (${MAX - statSync(zip).size} spare)`);
});
check("title screen loads with no errors", () => drive("title", []));
check("a scored round plays through", () =>
  drive("round", ["--keys", "Enter:5000,1:400,3:20", "--settle", "600"]));
check("jam mode takes input", () => drive("jam", ["--click", "450,413@400;150,505@200"]));
check("composer takes input", () => drive("compose", ["--click", "545,413@400;150,505@200"]));
check("hardcore briefing opens and starts", () =>
  drive("hardcore", ["--click", "292,413@400;450,357@2000"]));
check("a shared pattern link loads", () =>
  execFileSync("node", ["scripts/shot.js", "--url", "file://" + dist + "#0132.111.", "--out", "/dev/null"], {
    stdio: "pipe",
  }));
check("a shared jam link loads", () =>
  execFileSync("node", ["scripts/shot.js", "--url", "file://" + dist + "#j.00020k41411o323", "--out", "/dev/null"], {
    stdio: "pipe",
  }));

console.log(failed ? `smoke: ${failed} failed` : "smoke: all good");
process.exit(failed ? 1 : 0);
