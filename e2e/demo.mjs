// The README's demo, docs/screenshots/demo.{gif,mp4,jpg}, recorded from the demo repositories: node e2e/demo.mjs
// Needs what the e2e tests need, its display one ffmpeg can grab (Xvfb), and ffmpeg.
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { demo, groupWorkspace, launch } from "./driver.mjs";

const out = new URL("../docs/screenshots/", import.meta.url).pathname, raw = join(tmpdir(), "krill-demo.mkv");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// where the pointer waits, over nothing that answers a hover
const REST = { x: 1390, y: 640 };
let k, at = { x: 0, y: 0 };

const pointer = (actions) => k.cmd("POST", "actions", { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions }] });

/** The pointer to `x`, `y` in `ms`, slow at both ends. */
async function glide(x, y, ms = Math.min(900, 250 + Math.hypot(x - at.x, y - at.y) * 0.6)) {
  const steps = Math.max(1, Math.round(ms / 25)), from = at;
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (2 - 2 * t) ** 2 / 2);
  at = { x, y };
  await pointer(Array.from({ length: steps }, (_, i) => ({ type: "pointerMove", origin: "viewport", duration: Math.round(ms / steps), x: Math.round(from.x + (x - from.x) * ease((i + 1) / steps)), y: Math.round(from.y + (y - from.y) * ease((i + 1) / steps)) })));
}

/** The pointer to the middle of the first element `css` finds whose text includes `text`. */
async function to(css, text = "") {
  const r = await k.until(
    (css, text) => {
      const e = [...document.querySelectorAll(css)].find((e) => e.textContent.includes(text) && e.getClientRects().length);
      if (!e) return null;
      e.scrollIntoView({ block: "nearest" });
      const b = e.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    },
    css,
    text,
  );
  await glide(r.x, r.y);
  await sleep(150);
}

async function click(css, text) {
  await to(css, text);
  await pointer([{ type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }]);
}

async function shiftClick(css, text) {
  await to(css, text);
  const key = (type) => ({ type, value: "" });
  await k.cmd("POST", "actions", {
    actions: [
      { type: "key", id: "keyboard", actions: [key("keyDown"), { type: "pause" }, { type: "pause" }, key("keyUp")] },
      { type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pause" }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }, { type: "pause" }] },
    ],
  });
}

// WebDriver's right button also sends a click, which closes menus: the event comes from the page
async function menu(css, text) {
  await to(css, text);
  await k.js((x, y) => document.elementFromPoint(x, y).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y })), at.x, at.y);
}

const type = (text) => k.cmd("POST", "actions", { actions: [{ type: "key", id: "keyboard", actions: [...text].flatMap((value) => [{ type: "keyDown", value }, { type: "keyUp", value }, { type: "pause", duration: 55 }]) }] });

// stage a hunk and a picture, commit, squash three commits, then undo it all: the last frame is the first
async function scene() {
  // the views the last run left, back as a fresh profile has them
  await k.js(() => (localStorage.setItem("diff-mode", "hunk"), localStorage.setItem("svg-view", "text")));
  await sleep(800);
  await click('#unstaged .file[data-path="src/tide.rs"]');
  await k.until(() => document.querySelector("#diff-editor .hunk-bar button.hunk-stage"));
  await sleep(700);
  await click("#diff-editor .hunk-bar button.hunk-stage");
  await k.until(() => document.querySelector('#staged .file[data-path="src/tide.rs"]'));
  await sleep(500);
  // the logo's text, side by side, then its two pictures
  await click('#unstaged .file[data-path="docs/logo.svg"]');
  await k.until(() => !document.getElementById("svg-view").hidden);
  await sleep(700);
  await click('[data-mode="split"]');
  await sleep(900);
  await click('[data-svg="image"]');
  await k.until(() => [...document.querySelectorAll("#diff-binary img")].filter((i) => i.complete && i.naturalWidth).length === 2);
  await sleep(1600);
  // its row's button shows on a hover
  await to('#unstaged .file[data-path="docs/logo.svg"]');
  await click('#unstaged .file[data-path="docs/logo.svg"] button', "Stage");
  await k.until(() => document.querySelector('#staged .file[data-path="docs/logo.svg"]'));
  await sleep(300);
  await click("#summary");
  await type("feat(tide): add Saint-Malo, a logo at night");
  await sleep(300);
  await click("#commit-btn");
  await k.until(() => document.querySelector("#graph .row.row-head")?.textContent.includes("Saint-Malo"));
  // the commit closes the diff
  await k.until(() => document.getElementById("diff").hidden);
  await sleep(1000);
  // the new commit and the two before it squashed into the one under them
  await menu("#graph .row", "chore: release 0.2.0");
  await sleep(500);
  await click("#menu button", "Interactive rebase");
  await k.until(() => !document.getElementById("rebase").hidden);
  await sleep(800);
  await shiftClick("#rebase-rows .rb-row", "move to the 2024 edition");
  await sleep(400);
  await menu("#rebase-rows .rb-row", "move to the 2024 edition");
  await sleep(400);
  await click("#menu button", "Squash 3 commits");
  await sleep(900);
  await click("#rebase-start");
  await k.until(() => document.getElementById("rebase").hidden && document.querySelector("#graph .row.row-head")?.textContent.includes("one file per region"));
  await sleep(1200);
  // all of it undone
  await click("#undo");
  await k.until(() => document.querySelector("#graph .row.row-head")?.textContent.includes("Saint-Malo"));
  await sleep(700);
  await click("#undo");
  await k.until(() => document.querySelector('#staged .file[data-path="docs/logo.svg"]'));
  await sleep(600);
  await click("#unstage-all");
  await k.until(() => !document.querySelector("#staged .file"));
  await sleep(300);
  await glide(REST.x, REST.y);
  await k.settle();
}

/** The frame at `seek` seconds into the recording (negative: from its end) as a PNG. */
const frame = (seek) => PNG.sync.read(execFileSync("ffmpeg", ["-v", "error", ...(seek < 0 ? ["-sseof", String(seek)] : ["-ss", String(seek)]), "-i", raw, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"]));

k = await launch(`${demo("workspace")}/tidepool`);
try {
  await groupWorkspace(k);
  // the pointer, drawn in the page: WebDriver moves no pointer on the screen
  await k.js(() => {
    const p = document.createElement("div");
    p.innerHTML = '<svg width="22" height="22"><path d="M2 2v16l4.5-4.2 3 6.6 2.8-1.2-3-6.5H16z" fill="#fff" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/></svg>';
    p.style.cssText = "position: fixed; left: -2px; top: -2px; z-index: 2147483647; pointer-events: none; line-height: 0";
    document.body.append(p);
    addEventListener("pointermove", (e) => (p.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`), true);
    // no tooltips: they would show where the screen's own pointer sits, mid-screen
    const untitle = () => document.querySelectorAll("[title]").forEach((el) => el.removeAttribute("title"));
    untitle();
    new MutationObserver(untitle).observe(document.body, { attributes: true, attributeFilter: ["title"], childList: true, subtree: true });
  });
  // once off the record: the second run starts warm, where the first ended
  await scene();
  const { x, y, width, height } = await k.cmd("GET", "window/rect");
  const rec = spawn("ffmpeg", ["-y", "-v", "error", "-f", "x11grab", "-draw_mouse", "0", "-framerate", "30", "-video_size", `${width}x${height}`, "-i", `${process.env.DISPLAY}+${x},${y}`, "-c:v", "libx264rgb", "-crf", "0", "-preset", "ultrafast", raw], { stdio: ["pipe", "inherit", "inherit"] });
  await sleep(1000);
  await scene();
  await sleep(500);
  rec.stdin.end("q");
  await new Promise((r) => rec.on("exit", r));
} finally {
  await k.quit();
}
const [first, last] = [frame(0.5), frame(-0.1)];
console.log(`first and last frames: ${pixelmatch(first.data, last.data, null, first.width, first.height, { threshold: 0.1 })} pixels differ`);
const encode = (...args) => (execFileSync("ffmpeg", ["-y", "-v", "error", "-i", raw, ...args]), console.log(args.at(-1).split("/").pop()));
encode("-vf", "fps=12,scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5", `${out}demo.gif`);
encode("-c:v", "libx264", "-crf", "26", "-pix_fmt", "yuv420p", "-movflags", "+faststart", `${out}demo.mp4`);
encode("-ss", "0.5", "-frames:v", "1", "-q:v", "3", `${out}demo.jpg`);
