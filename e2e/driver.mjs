// Git Krill driven through tauri-driver (WebDriver over HTTP), a fresh profile and repositories per session.
// Needs tauri-driver and WebKitWebDriver (or WEBKIT_WEBDRIVER), Xvfb (each launch on a display of its own), and the debug build (or KRILL_APP).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const ROOT = new URL("..", import.meta.url).pathname;
const APP = process.env.KRILL_APP ?? join(ROOT, "src-tauri/target/debug/git-krill");
// check against e2e/golden in CI, where they were made; elsewhere fonts differ: only kept in e2e/out to look at
const GOLDEN = process.env.GOLDEN ?? (process.env.CI ? "check" : "skip");
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a test file's repositories, in the same folders each run: a tab's colour comes from its path; apart from other files', which run alongside
const FILE = process.env.NODE_TEST_CONTEXT ? basename(process.argv[1]) : "";
let made = 0;
const repoDir = () => {
  const dir = join(tmpdir(), "krill-e2e-repos", FILE, String(++made));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** A folder of its own with the README's demo repositories (demo/tidepool, demo/conflict/tidepool); `opts` go to test/make-demo.sh after the folder. */
export function demo(...opts) {
  const dir = repoDir();
  execFileSync("sh", [join(ROOT, "test/make-demo.sh"), dir, ...opts], { env: gitEnv(dir), stdio: "ignore" });
  return join(dir, "demo");
}

/** The workspace demo's other two projects opened from the Workspace section, the three tabs in a group "tides", tidepool's open. */
export async function groupWorkspace(k) {
  for (const p of ["tidecalc", "tide-web"]) {
    await k.menu('#sidebar [data-key="workspace"] .item', p);
    await k.click("#menu button", "Open");
    await k.until((p) => document.querySelector("#tablist .tab.on .tab-name")?.textContent === p, p);
  }
  await k.click("#tablist .tab", "tidepool");
  // a pick redraws the tabs: each found anew
  for (let i = 0; i < 2; i++) await k.js(() => document.querySelector("#tablist .tab:not(.on):not(.picked)").dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true })));
  await k.menu("#tablist .tab.picked");
  await k.click("#menu button", "Add 3 tabs to new group");
  await k.type("#tablist .tab-group input", "tides");
  await k.keys("");
  await k.until(() => document.querySelector("#tablist .tab-group")?.textContent === "tides");
}

/** A repository made by `make({ dir, git, commit, write })` in a folder of its own: each commit a day after the last, from 2026-01-01. */
export function repo(make) {
  const top = repoDir(), dir = join(top, "repo"), env = gitEnv(top);
  let day = 0;
  const git = (...args) => execFileSync("git", args, { cwd: dir, env, maxBuffer: 1 << 30 }).toString();
  const date = () => new Date(Date.UTC(2026, 0, 1 + day)).toISOString();
  const commit = (msg) => (day++, execFileSync("git", ["commit", "-qm", msg], { cwd: dir, env: { ...env, GIT_AUTHOR_DATE: date(), GIT_COMMITTER_DATE: date() } }));
  const write = (path, text) => (mkdirSync(join(dir, path, ".."), { recursive: true }), writeFileSync(join(dir, path), text));
  mkdirSync(dir);
  git("init", "-q");
  make({ dir, git, commit, write });
  return dir;
}

// the user's git settings left out: no signing, no hooks of theirs
const gitEnv = (dir) => {
  const config = join(dir, "gitconfig");
  writeFileSync(config, "[user]\n\tname = Krill Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgSign = false\n");
  return { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", TZ: "UTC" };
};

/** `n` distinct ports free on this machine now. */
async function freePorts(n) {
  const servers = await Promise.all(Array.from({ length: n }, () => new Promise((done) => { const s = createServer().listen(0, "127.0.0.1", () => done(s)); })));
  const ports = servers.map((s) => s.address().port);
  await Promise.all(servers.map((s) => new Promise((done) => s.close(done))));
  return ports;
}

/** An Xvfb display of its own, the CI's size: windows of test files run side by side never share focus; it ends with its app's window, a killed test included. */
function xvfb() {
  const x = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1920x1080x24", "-nolisten", "tcp", "-terminate"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
  return new Promise((done, fail) => {
    x.stdio[3].once("data", (n) => done({ x, display: `:${String(n).trim()}` }));
    x.once("exit", (code) => fail(new Error(`Xvfb exited with ${code}`)));
  });
}

/** Git Krill open on `repo` (none: the tabs it kept), in a profile of its own or `home`'s, with e2e/bin's gh; `more` overrides its environment: a DISPLAY there is used instead of a display of its own. */
export async function launch(repo, more = {}, home = mkdtempSync(join(tmpdir(), "krill-e2e-"))) {
  const run = join(home, "run");
  mkdirSync(run, { mode: 0o700, recursive: true });
  const env = {
    ...gitEnv(home),
    PATH: `${join(ROOT, "e2e/bin")}:${process.env.PATH}`,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_RUNTIME_DIR: run,
    LANG: "C.UTF-8",
    MESA_SHADER_CACHE_DISABLE: "true",
    ...more,
  };
  // a display and ports of its own: test files run side by side
  const screen = more.DISPLAY ? null : await xvfb();
  if (screen) env.DISPLAY = screen.display;
  const [port, nativePort] = await freePorts(2);
  const native = process.env.WEBKIT_WEBDRIVER ? ["--native-driver", process.env.WEBKIT_WEBDRIVER] : [];
  const driver = spawn("tauri-driver", ["--port", String(port), "--native-port", String(nativePort), ...native], { env, stdio: "ignore" });
  const k = new Krill(driver, home, port, screen?.x);
  for (let i = 0; !k.id; i++) {
    try {
      k.id = (await k.req("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: APP, args: repo ? [repo] : [] } } } })).sessionId;
    } catch (e) {
      // the driver still starting
      if (i > 50) throw (driver.kill(), screen?.x.kill(), e);
      await sleep(200);
    }
  }
  try {
    // the repository or Settings on screen, the splash gone: a click before lands on it
    await k.until(() => document.querySelector("#graph .row") || !document.getElementById("settings").hidden);
    await k.settle();
    return k;
  } catch (e) {
    // its window never came: closed with its driver, else the next launch finds no session free
    await k.quit();
    throw e;
  }
}

class Krill {
  constructor(driver, home, port, screen) {
    Object.assign(this, { driver, home, port, screen, id: "" });
  }

  async req(method, path, body) {
    const r = await fetch(`http://127.0.0.1:${this.port}${path}`, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
    const { value } = await r.json();
    if (!r.ok) throw new Error(`${method} ${path}: ${value?.error ?? r.status} ${value?.message ?? ""}`);
    return value;
  }

  cmd = (method, path, body) => this.req(method, `/session/${this.id}/${path}`, body);

  /** `fn` run in the window with `args`; its result. */
  js = (fn, ...args) => this.cmd("POST", "execute/sync", { script: `return (${fn})(...arguments)`, args });

  /** Until `fn` in the window returns something truthy, which it returns. */
  async until(fn, ...args) {
    for (const end = Date.now() + 15_000; ; await sleep(100)) {
      const v = await this.js(fn, ...args);
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${fn} (${args.join(", ")})`);
    }
  }

  /** Until the window is idle: no busy pointer, no fade or slide under way, no view held hidden or covered while the next one draws, a frame drawn. */
  async settle() {
    await sleep(150);
    await this.until(
      () =>
        !document.body.classList.contains("slow") &&
        !document.querySelector("#diff.blank, #hist-main.blank, .still") &&
        // the clean WIP list's shrimp swims for half a minute: nothing waits on it
        document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity || a.effect?.target?.closest?.(".shrimp-sea")),
    );
    await this.js(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }

  /** A click on the first element `css` finds whose text includes `text`, by the pointer at its middle: what covers it gets it, as for a user. */
  async click(css, text = "", tries = 3) {
    // a button fading in cannot take a click yet
    await this.settle();
    const el = await this.until(
      (css, text) => {
        const e = [...document.querySelectorAll(css)].find((e) => e.textContent.includes(text) && e.getClientRects().length);
        e?.scrollIntoView({ block: "nearest" });
        return e;
      },
      css,
      text,
    );
    // Monaco takes a scroll into its own position on the next frame: a click before it lands as if unscrolled
    await this.js(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const actions = [{ type: "pointerMove", origin: el, x: 0, y: 0 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }];
    const err = await this.cmd("POST", "actions", { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions }] }).then(() => null, (e) => e);
    // a refresh redrew it between the find and the click: found again
    if (err && /stale element/.test(err.message) && tries > 1) return this.click(css, text, tries - 1);
    if (err) throw new Error(`${css} "${text}": ${err.message}`);
    await this.cmd("DELETE", "actions");
  }

  /** A right-click's menu on the first element `css` finds whose text includes `text`: WebDriver's own right button also sends a click, which closes menus. */
  async menu(css, text = "") {
    await this.settle();
    await this.until(
      (css, text) => {
        const e = [...document.querySelectorAll(css)].find((e) => e.textContent.includes(text) && e.getClientRects().length);
        if (!e) return false;
        e.scrollIntoView({ block: "nearest" });
        const r = e.getBoundingClientRect();
        return e.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })) || true;
      },
      css,
      text,
    );
  }

  /** Keys pressed together, as WebDriver names them: "" Control, "" Shift. */
  async keys(...keys) {
    const actions = [...keys.map((value) => ({ type: "keyDown", value })), ...keys.reverse().map((value) => ({ type: "keyUp", value }))];
    await this.cmd("POST", "actions", { actions: [{ type: "key", id: "keyboard", actions }] });
  }

  /** `text` typed into the field `css` finds, emptied first. */
  async type(css, text) {
    const el = await this.until((css) => document.querySelector(css), css);
    await this.cmd("POST", `element/${el[ELEMENT]}/clear`, {});
    await this.cmd("POST", `element/${el[ELEMENT]}/value`, { text });
  }


  /** The window as an image, against e2e/golden/<name>.png: a few pixels may differ. */
  async shot(name) {
    await this.js(() => document.activeElement?.blur());
    await this.settle();
    const png = Buffer.from(await this.cmd("GET", "screenshot"), "base64");
    mkdirSync(join(ROOT, "e2e/out"), { recursive: true });
    writeFileSync(join(ROOT, "e2e/out", `${name}.png`), png);
    const golden = join(ROOT, "e2e/golden", `${name}.png`);
    if (GOLDEN === "skip") return;
    if (GOLDEN === "update" || !existsSync(golden)) return void (mkdirSync(join(ROOT, "e2e/golden"), { recursive: true }), writeFileSync(golden, png));
    const [a, b] = [readFileSync(golden), png].map((p) => PNG.sync.read(p));
    if (a.width !== b.width || a.height !== b.height) throw new Error(`${name}: ${b.width}×${b.height}, the golden is ${a.width}×${a.height}`);
    const diff = new PNG({ width: a.width, height: a.height });
    const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
    // antialiasing moves a few pixels between runs; a word changed is hundreds
    if (n > 100) {
      writeFileSync(join(ROOT, "e2e/out", `${name}.diff.png`), PNG.sync.write(diff));
      throw new Error(`${name}: ${n} pixels differ from e2e/golden/${name}.png (see e2e/out)`);
    }
  }

  /** Close the app; its profile goes too unless `keep`, for a launch on it again. */
  async quit(keep = false) {
    await this.req("DELETE", `/session/${this.id}`).catch(() => {});
    this.driver.kill();
    this.screen?.kill();
    if (keep) return;
    // the app may still be writing its caches as it goes
    try {
      rmSync(this.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {}
  }
}
