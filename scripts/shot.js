#!/usr/bin/env node
// Screenshots the running game in headless Chrome, optionally after simulating input,
// and reports anything the page logged or threw.
//
// The point: when you're on the iPad in rootshell there's no JS console and no way to
// eyeball a render. This gives both you and Claude a look at the actual pixels plus the
// errors that Safari would otherwise swallow.
//
// Zero dependencies -- talks the DevTools Protocol over Node's native WebSocket.
//
//   node scripts/shot.js
//   node scripts/shot.js --keys ArrowRight:600 --out shots/moved-right.png
//   node scripts/shot.js --keys "ArrowRight+ArrowUp:400,Space:80" --wait 1000
//
// Options:
//   --url <url>      page to load            (default http://127.0.0.1:8081/)
//   --out <path>     png destination         (default shots/shot.png)
//   --size <WxH>     viewport                (default 800x600)
//   --wait <ms>      settle before input     (default 500)
//   --keys <spec>    comma-separated holds; "+" chords them. e.g. ArrowRight:500
//   --click <spec>   ";"-separated taps: "450,420;150,500" -- add "@400" to wait after
//   --drag <spec>    ";"-separated swipes: "120,505>790,505" -- runs after clicks
//   --settle <ms>    settle after input      (default 300)
//   --timeout <ms>   overall bail-out        (default 30000)
//
// Exits non-zero if the page threw an uncaught error, so it doubles as a smoke test.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const argv = parse(process.argv.slice(2));
const URL_ = argv.url ?? "http://127.0.0.1:8081/";
const OUT = argv.out ?? "shots/shot.png";
const [W, H] = (argv.size ?? "800x600").split("x").map(Number);
const WAIT = int(argv.wait, 500);
const SETTLE = int(argv.settle, 300);
const TIMEOUT = int(argv.timeout, 30000);
const CHROME = process.env.CHROME ?? "google-chrome";

// Arrow keys and friends need an explicit virtual keycode or the page sees nothing.
const KEYS = {
	ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
	ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
	ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
	ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
	Space: { key: " ", code: "Space", vk: 32 },
	Enter: { key: "Enter", code: "Enter", vk: 13 },
	Escape: { key: "Escape", code: "Escape", vk: 27 },
	Shift: { key: "Shift", code: "ShiftLeft", vk: 16 },
};

const userDataDir = mkdtempSync(path.join(tmpdir(), "js13k-shot-"));
let chrome, ws;

const bail = setTimeout(() => {
	console.error(`shot: timed out after ${TIMEOUT}ms`);
	cleanup();
	process.exit(1);
}, TIMEOUT);

try {
	chrome = spawn(CHROME, [
		"--headless",
		"--disable-gpu",
		"--no-sandbox",
		"--hide-scrollbars",
		"--mute-audio",
		"--no-first-run",
		`--window-size=${W},${H}`,
		`--user-data-dir=${userDataDir}`,
		"--remote-debugging-port=0", // Chrome writes the real port to DevToolsActivePort
		"about:blank",
	], { stdio: ["ignore", "ignore", "pipe"] });

	const port = await poll(() => {
		const f = path.join(userDataDir, "DevToolsActivePort");
		return existsSync(f) ? readFileSync(f, "utf8").split("\n")[0].trim() : null;
	});

	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
	const page = targets.find((t) => t.type === "page");
	if (!page) throw new Error("no page target in Chrome");

	ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("devtools socket failed")); });

	let id = 0;
	const pending = new Map();
	const logs = [];
	const fatal = [];

	ws.onmessage = (ev) => {
		const m = JSON.parse(ev.data);
		if (m.id !== undefined) {
			const p = pending.get(m.id);
			if (!p) return;
			pending.delete(m.id);
			m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
			return;
		}
		if (m.method === "Runtime.consoleAPICalled") {
			const text = m.params.args.map(preview).join(" ");
			logs.push(`[${m.params.type}] ${text}`);
			if (m.params.type === "error") fatal.push(text);
		} else if (m.method === "Runtime.exceptionThrown") {
			const d = m.params.exceptionDetails;
			const text = d.exception?.description ?? d.text;
			logs.push(`[uncaught] ${text}`);
			fatal.push(text);
		} else if (m.method === "Log.entryAdded") {
			const e = m.params.entry;
			if (e.source === "network" && /favicon/.test(e.url ?? "")) return; // always 404s, never interesting
			logs.push(`[${e.level}] ${e.text}`);
			// Network noise shouldn't fail the run -- only the game's own errors should.
			if (e.level === "error" && e.source !== "network") fatal.push(e.text);
		}
	};

	const send = (method, params = {}) => {
		const n = ++id;
		ws.send(JSON.stringify({ id: n, method, params }));
		return new Promise((resolve, reject) => pending.set(n, { resolve, reject }));
	};

	await send("Runtime.enable");
	await send("Log.enable");
	await send("Page.enable");
	// Force the exact viewport. Headless window size includes chrome, so without this
	// the png comes back short -- and it lets --size emulate the iPad for layout checks.
	await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

	const loaded = once(ws, "Page.loadEventFired");
	await send("Page.navigate", { url: URL_ });
	await loaded;

	await sleep(WAIT);

	// Hold each group for its duration so movement/physics actually advance.
	for (const step of String(argv.keys ?? "").split(",").filter(Boolean)) {
		const [names, ms] = step.split(":");
		const group = names.split("+").map((n) => n.trim()).filter(Boolean);
		for (const n of group) await send("Input.dispatchKeyEvent", keyEvent("rawKeyDown", n));
		await sleep(int(ms, 200));
		for (const n of group) await send("Input.dispatchKeyEvent", keyEvent("keyUp", n));
	}

	// Clicks: needed to reach on-screen buttons, which keyboard input cannot.
	for (const step of String(argv.click ?? "").split(";").filter(Boolean)) {
		const [pos, hold] = step.split("@");
		const [cx, cy] = pos.split(",").map(Number);
		const base = { x: cx, y: cy, button: "left", clickCount: 1 };
		await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...base, buttons: 0 });
		await send("Input.dispatchMouseEvent", { type: "mousePressed", ...base, buttons: 1 });
		await sleep(35);
		await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, buttons: 0 });
		await sleep(int(hold, 260));
	}

	// Drags: press, glide through N steps, release. Needed to exercise slide input.
	for (const step of String(argv.drag ?? "").split(";").filter(Boolean)) {
		const [path, hold] = step.split("@");
		const [from, to] = path.split(">");
		const [ax, ay] = from.split(",").map(Number);
		const [bx, by] = to.split(",").map(Number);
		const steps = 24;
		await send("Input.dispatchMouseEvent", { type: "mousePressed", x: ax, y: ay, button: "left", clickCount: 1, buttons: 1 });
		for (let i = 1; i <= steps; i++) {
			const t = i / steps;
			await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: ax + (bx - ax) * t, y: ay + (by - ay) * t, button: "left", buttons: 1 });
			await sleep(18);
		}
		await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: bx, y: by, button: "left", clickCount: 1, buttons: 0 });
		await sleep(int(hold, 200));
	}

	if (argv.keys || argv.click || argv.drag) await sleep(SETTLE);

	const { data } = await send("Page.captureScreenshot", { format: "png" });
	mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
	writeFileSync(OUT, Buffer.from(data, "base64"));

	console.log(`shot: ${OUT} (${W}x${H}) <- ${URL_}${argv.keys ? ` keys=${argv.keys}` : ""}${argv.click ? ` click=${argv.click}` : ""}${argv.drag ? ` drag=${argv.drag}` : ""}`);
	if (logs.length) {
		console.log("--- page output ---");
		for (const l of logs) console.log(l);
	} else {
		console.log("page output: (none)");
	}

	cleanup();
	process.exit(fatal.length ? 1 : 0);
} catch (err) {
	console.error(`shot: ${err.message}`);
	cleanup();
	process.exit(1);
}

function keyEvent(type, name) {
	const k = KEYS[name] ?? {
		key: name,
		code: /^[a-z]$/i.test(name) ? `Key${name.toUpperCase()}` : name,
		vk: name.toUpperCase().charCodeAt(0),
	};
	return { type, key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
}

function once(socket, method) {
	return new Promise((resolve) => {
		const prev = socket.onmessage;
		socket.onmessage = (ev) => {
			prev?.(ev);
			if (JSON.parse(ev.data).method === method) { socket.onmessage = prev; resolve(); }
		};
	});
}

function preview(a) {
	if ("value" in a) return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
	return a.description ?? a.type;
}

async function poll(fn, every = 50) {
	for (;;) {
		const v = fn();
		if (v) return v;
		await sleep(every);
	}
}

// Function declarations, not const arrows: the top-level config block below the imports
// runs before a const in this footer would be initialized.
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function int(v, d) { return Number.isFinite(Number(v)) ? Number(v) : d; }

function parse(args) {
	const out = {};
	for (let i = 0; i < args.length; i++) {
		if (!args[i].startsWith("--")) continue;
		const [k, inline] = args[i].slice(2).split("=");
		out[k] = inline ?? (args[i + 1]?.startsWith("--") ? true : args[++i]);
	}
	return out;
}

function cleanup() {
	clearTimeout(bail);
	try { ws?.close(); } catch {}
	try { chrome?.kill(); } catch {}
	try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
}
