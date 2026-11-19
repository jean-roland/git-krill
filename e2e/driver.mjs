// Git Krill driven through tauri-driver (WebDriver over HTTP), a fresh profile and repositories per session.
// Needs tauri-driver and WebKitWebDriver (or WEBKIT_WEBDRIVER), a display, and the debug build (or KRILL_APP).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const ROOT = new URL("..", import.meta.url).pathname;
const APP = process.env.KRILL_APP ?? join(ROOT, "src-tauri/target/debug/git-krill");
const PORT = 4444;
// check against e2e/golden in CI, where they were made; elsewhere fonts differ: only kept in e2e/out to look at
const GOLDEN = process.env.GOLDEN ?? (process.env.CI ? "check" : "skip");
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a test file's repositories, in the same folders each run: a tab's colour comes from its path
let made = 0;
const repoDir = () => {
  const dir = join(tmpdir(), "krill-e2e-repos", String(++made));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** A folder of its own with the README's demo repositories (demo/tidepool, demo/conflict/tidepool). */
export function demo() {
  const dir = repoDir();
  execFileSync("sh", [join(ROOT, "test/make-demo.sh"), dir], { env: gitEnv(dir), stdio: "ignore" });
  return join(dir, "demo");
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

/** Git Krill open on `repo` (none: the tabs it kept), in a profile of its own or `home`'s, with e2e/bin's gh; `more` overrides its environment. */
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
  const native = process.env.WEBKIT_WEBDRIVER ? ["--native-driver", process.env.WEBKIT_WEBDRIVER] : [];
  const driver = spawn("tauri-driver", ["--port", String(PORT), ...native], { env, stdio: "ignore" });
  const k = new Krill(driver, home);
  for (let i = 0; !k.id; i++) {
    try {
      k.id = (await k.req("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: APP, args: repo ? [repo] : [] } } } })).sessionId;
    } catch (e) {
      // the driver still starting
      if (i > 50) throw (driver.kill(), e);
      await sleep(200);
    }
  }
  try {
    // the repository on screen, the splash gone: a click before lands on it
    await k.until(() => document.querySelector("#graph .row"));
    await k.settle();
    return k;
  } catch (e) {
    // its window never came: closed with its driver, else the next launch finds no session free
    await k.quit();
    throw e;
  }
}

class Krill {
  constructor(driver, home) {
    Object.assign(this, { driver, home, id: "" });
  }

  async req(method, path, body) {
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
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
        document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity),
    );
    await this.js(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }

  /** A click on the first element `css` finds whose text includes `text`, by the pointer at its middle: what covers it gets it, as for a user. */
  async click(css, text = "") {
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
    await this.cmd("POST", "actions", { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions }] }).catch((e) => {
      throw new Error(`${css} "${text}": ${e.message}`);
    });
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
    if (keep) return;
    // the app may still be writing its caches as it goes
    try {
      rmSync(this.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {}
  }
}
