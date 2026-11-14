import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { DEFAULT_EDITOR, fetchMinutes } from "./repo";
import { $, ICONS, dateTimeText, h, ico, pickDir, say, showMenu, store, svg, toast } from "./ui";

type Tools = { git: string; lfs: string; gh: string; lfsSetUp: boolean; lfsInUse: boolean; ghHosts: string[] };
// the last answer, asked again on the background fetch's rhythm: once a run while it is off
let checked: { at: number; tools: Tools } | null = null;
// the order global_config answers in, lib.rs GLOBAL_KEYS: these, then commit.gpgsign, rerere.enabled, rerere.autoUpdate, fetch.writeCommitGraph
const IDENTITY: [string, string][] = [["user.name", "Name"], ["user.email", "Email"], ["user.signingkey", "Signing key"]];
const RERERE = ["rerere.enabled", "rerere.autoUpdate"];
// asked at startup: Settings opens filled in, then asks again
let globals = invoke<string[]>("global_config");

const row = (label: string, ...kids: (Node | string)[]) => h("div", { className: "set-row" }, h("span", { className: "set-label", textContent: label }), h("div", {}, ...kids));
const hint = (text: string) => h("small", { className: "set-hint", textContent: text });
// a tool's advice on its status line: a line of its own would make the rows jump when the answer comes
const note = (text: string) => h("small", { className: "set-note", textContent: text });
// "git-lfs/3.4.1 (GitHub; linux amd64; go 1.22.2)" says 3.4.1
const version = (line: string) => line.match(/\d+(\.\d+)+/)?.[0] ?? line;
const state = (ok: boolean, text: string) => h("span", { className: ok ? "set-ok" : "set-bad", textContent: `${ok ? "✓" : "✗"} ${text}` });

/** The Settings tab: the tools krill leans on, background fetch, the editor, the folder pickers' start, the global git identity, conflict replay and this build. */
export function renderSettings() {
  const tools = h("div", {}, ...checking()), global = globalRows();
  $("settings-box").replaceChildren(
    h("h1", {}, "Settings", h("small", { className: "set-build", textContent: `Build: ${__BUILD__.id}, ${dateTimeText(__BUILD__.time)}`, title: "This build: git describe, then when it was built" })),
    h("div", { className: "head" }, "Tool status ", h("button", { className: "set-again", innerHTML: `${svg(ICONS.sync)}Refresh`, title: "Check the tools again", onclick: () => paintTools(tools, true) })),
    tools,
    h("div", { className: "head", textContent: "Background fetch" }),
    ...fetchRows(),
    h("div", { className: "head", textContent: "Editor and folders" }),
    editorRow(),
    openDirRow(),
    h("div", { className: "head" }, "Git, for every repository", note("A repository's own settings win over these.")),
    ...global.git,
  );
  paintTools(tools);
}

const checking = () => ["git", "git-lfs", "gh"].map((name) => row(name, h("span", { className: "set-wait", textContent: "Checking…" })));

/** Each tool found or not, with what to do about it; asked again when `force`d or once the fetch interval has passed. */
async function paintTools(box: HTMLElement, force = false) {
  const stale = !checked || (store("auto-fetch") !== "off" && Date.now() - checked.at >= fetchMinutes() * 60_000);
  if (force || stale) {
    // the old answer goes at once, and a click's "Checking…" stays long enough to be seen: the tools answer in a blink
    box.replaceChildren(...checking());
    const [tools] = await Promise.all([invoke<Tools>("tool_status"), force && new Promise((done) => setTimeout(done, 300))]);
    checked = { at: Date.now(), tools };
  }
  const t = checked!.tools;
  const lfs = !t.lfs
    ? [state(false, "Not installed"), note("Install it, then run `git lfs install` once")]
    : !t.lfsSetUp
      ? [state(false, `${version(t.lfs)}, not set up`), note("Run `git lfs install` once")]
      : !t.lfsInUse
        ? [state(false, version(t.lfs)), note("Installed after Git Krill started: restart it")]
        : [state(true, version(t.lfs))];
  const gh = !t.gh
    ? [state(false, "Not installed"), note("Optional: lets the server verify commit signatures")]
    : !t.ghHosts.length
      ? [state(false, `${version(t.gh)}, signed in nowhere`), note("Run `gh auth login` for each server you push to")]
      : [state(true, version(t.gh)), note(`signed in to ${t.ghHosts.join(", ")}`)];
  box.replaceChildren(row("git", t.git ? state(true, version(t.git)) : state(false, "Not found: Git Krill needs it")), row("git-lfs", ...lfs), row("gh", ...gh));
}

function fetchRows() {
  const on = h("input", { type: "checkbox", checked: store("auto-fetch") !== "off", onchange: () => store("auto-fetch", on.checked ? "on" : "off") });
  // krill's own menu, not the system's list: GTK's box is a size bigger than the fields
  const label = h("span", { textContent: `${fetchMinutes()} min` });
  const pick = (n: number) => (store("fetch-minutes", String(n)), (label.textContent = `${n} min`));
  const every = h("button", { className: "set-pick" }, label, ico(ICONS.caret));
  every.onclick = (e) => {
    // the window's own click would close it at once
    e.stopPropagation();
    const at = every.getBoundingClientRect();
    showMenu([1, 5, 15, 30].map((n) => [`${n} min`, () => pick(n)]), at.left, at.bottom + 2);
  };
  return [
    row("Fetch", h("label", {}, on, " Fetch the remotes of the open repository in the background")),
    row("Every", every, note("Also when the window or a tab comes back, at most once a minute.")),
  ];
}

function editorRow() {
  const cmd = h("input", { value: store("editor") ?? DEFAULT_EDITOR, spellcheck: false });
  cmd.onchange = () => (store("editor", cmd.value.trim()), say("Editor command saved"));
  return row("Open in editor", cmd, hint("{file} and {line} are filled in. Left empty, the desktop's default app opens the file."));
}

function openDirRow() {
  const dir = h("input", { value: store("open-dir") ?? "", placeholder: "The desktop's choice", spellcheck: false });
  // the picker wants it absolute
  const save = async (p: string) => (store("open-dir", (dir.value = p.trim().replace(/^~(?=\/|$)/, await homeDir()))), say("Start folder saved"));
  dir.onchange = () => save(dir.value);
  const browse = h("button", { textContent: "Browse…", onclick: () => pickDir("Start folder").then((p) => void (p && save(p))) });
  return row("Start folder", h("div", { className: "dlg-row" }, dir, browse), hint("Where Open repository (Ctrl+O), Init and Clone's Browse start."));
}

/** ~/.gitconfig's identity, conflict replay and commit-graph, saved field by field. */
function globalRows() {
  const fields = IDENTITY.map(([key]) => h("input", { spellcheck: false, onchange: (e: Event) => set(key, (e.target as HTMLInputElement).value.trim()) }));
  const sign = h("input", { type: "checkbox", onchange: () => set("commit.gpgsign", sign.checked ? "true" : "") });
  // the replayed files come back staged: the stop is only for a look
  const rerere = h("input", { type: "checkbox", onchange: () => RERERE.forEach((k) => set(k, rerere.checked ? "true" : "")) });
  const graph = h("input", { type: "checkbox", onchange: () => set("fetch.writeCommitGraph", graph.checked ? "true" : "") });
  const fill = (values: string[]) => {
    fields.forEach((f, i) => (f.value = values[i]));
    sign.checked = values[3] === "true";
    rerere.checked = values[4] === "true";
    graph.checked = values[6] === "true";
  };
  const load = () => (globals = invoke<string[]>("global_config")).then(fill);
  globals.then(fill);
  // one write at a time: two would fight over the config's lock; a failed one shows what is really saved
  let writing = Promise.resolve();
  const set = (key: string, value: string) =>
    (writing = writing.then(() => invoke("set_global_config", { key, value }).then(() => say(`Saved ${key}`), (e) => (say(String(e), true), load()))));
  load();
  return {
    git: [
      ...IDENTITY.map(([, label], i) => row(label, fields[i])),
      row("Sign commits", h("label", {}, sign, " Sign every commit with the signing key")),
      row(
        "Reuse fixes",
        h("label", {}, rerere, " Reuse recorded resolutions (git rerere)"),
        hint("A conflict resolved once is resolved alike next time; the rebase still stops there."),
      ),
      // git gc writes it too: this keeps it current between two
      row("Big repositories", h("label", {}, graph, " Write the commit-graph on each fetch: history loads up to 2× faster")),
    ],
  };
}

/** Once ever, at a first stop on conflicts with rerere off: it would replay these fixes next time. */
export function rerereTip() {
  if (store("rerere-tip")) return;
  invoke<string[]>("global_config").then((values) => {
    if (values[4] === "true") return;
    store("rerere-tip", "shown");
    toast("Tip: reuse your conflict fixes", "Turn on Reuse recorded resolutions in Settings: git then resolves a conflict it met before the way you did.", "info");
  });
}
