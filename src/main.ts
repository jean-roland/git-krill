import { invoke, Channel } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type * as Monaco from "monaco-editor/esm/vs/editor/edcore.main";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { applyChanges, allLines, pickLines, layoutGraph, parseConflicts, mergeSides, pickedLines, parseBlame, sprite, toggleSide, toggleLine, hasSide, repoName } from "./core.js";

type Change = { path: string; old: string | null; code: string; conflict?: string };
type OpInfo = { state: string; current: string; incoming: string; currentCommit: string; incomingCommit: string; step: string; message: string };
type Commit = { hash: string; parents: string[]; author: string; time: number; refs: string[]; subject: string; body: string };
type Status = { branch: string; state: string; ahead: number | null; behind: number | null; staged: Change[]; unstaged: Change[] };
type Ref = { name: string; hash: string; upstream: string; track: string };
type Stash = { name: string; hash: string; parents: string[]; subject: string };
type Worktree = { path: string; head: string; branch: string; locked: boolean; prunable: boolean };
type Refs = { refs: Ref[]; stashes: Stash[]; remotes: string[]; worktrees: Worktree[] };
type Blob = { text: string; exists: boolean; binary: boolean };
// file: a discard, the work tree text before and after (null: no file)
type Step = { op: string; branch: [string, string]; head: [string, string]; file?: [string, string | null, string | null] };
type Tab = { repo: string; selected: string[]; msg: string; scroll: number; undo: Step[]; redo: Step[]; worktree: boolean };
type Dir = { dirs: Map<string, Dir>; files: Change[] };
type Label = { name: string; tag: boolean; head: boolean; local: boolean; remotes: string[] };
type Kind = "unstaged" | "staged" | "commit";
type Mode = "hunk" | "inline" | "split";
type C4 = { os: number; oe: number; ms: number; me: number };
type Lines = { removed: Set<number>; added: Set<number> };
// null draws a separator
// an entry with items opens them beside it on hover
type MenuItem = [string, (() => unknown) | MenuItem[]] | null;
type Term = { term: Terminal; fit: FitAddon; el: HTMLElement; id: number; armed: boolean };

(self as any).MonacoEnvironment = { getWorker: () => new EditorWorker() };
// most of the bundle: loaded after the first paint, awaited by whatever opens a diff
let monaco: typeof Monaco;
let monacoLoad: Promise<void> | null = null;
const loadMonaco = () =>
  (monacoLoad ??= Promise.all([
    import("monaco-editor/esm/vs/editor/edcore.main"),
    import("monaco-editor/esm/vs/basic-languages/monaco.contribution"),
    import("monaco-editor/esm/vs/basic-languages/cpp/cpp.js"),
  ]).then(([m, , cpp]) => {
    monaco = m;
    // VS Code colors C names from its language server: guess macros, calls and types from their shape
    const root = [
      [/[A-Z][A-Z0-9_]+\b/, "identifier.macro"],
      [/[a-zA-Z_]\w*(?=\s*\()/, { cases: { "@keywords": "keyword.$0", "@default": "identifier.function" } }],
      [/[a-zA-Z_]\w*_t\b/, "type"],
      ...cpp.language.tokenizer.root,
    ] as Monaco.languages.IMonarchLanguageRule[];
    for (const id of ["c", "cpp"]) monaco.languages.setMonarchTokensProvider(id, { ...cpp.language, tokenizer: { ...cpp.language.tokenizer, root } });
  }));

const ROW = 26, LANE = 22, LOG_LIMIT = 3000;
const COLORS = ["#46b1ab", "#5d88d9", "#9c5dd9", "#5bc78e", "#d9ba5d", "#d95d96", "#d97d5d", "#d95d72"];
// ops that move HEAD, walked back with a reset or a checkout
const UNDOABLE = new Set([
  "commit", "amend", "reword", "checkout", "merge", "rebase", "cherry-pick", "pull",
  "branch-create", "reset-soft", "reset-mixed", "reset-hard", "revert",
]);
const KEEP_INDEX = new Set(["commit", "amend", "reword", "reset-soft", "reset-mixed"]);
// ops whose result is on a remote or gone from view: a toast confirms them, from (arg, arg2, branch, its upstream)
const DONE: Record<string, (arg: string, arg2: string, branch: string, upstream: string) => string> = {
  push: (_a, _b, branch, upstream) => `Pushed ${branch} to ${upstream}`,
  "push-upstream": (remote, name, branch) => `Pushed ${branch} to ${remote}/${name}`,
  "push-delete": (remote, name) => `Deleted ${name.replace(/^refs\/tags\//, "tag ")} on ${remote}`,
  "tag-push": (remote, name) => `Pushed tag ${name} to ${remote}`,
  "tag-delete": (name) => `Deleted tag ${name}`,
  "delete-branch": (name) => `Deleted branch ${name}`,
  "force-delete-branch": (name) => `Deleted branch ${name}`,
  "worktree-remove": (path) => `Removed worktree ${basename(path)}`,
  "worktree-force-remove": (path) => `Removed worktree ${basename(path)}`,
  "worktree-prune": () => "Pruned the worktrees whose folder is gone",
};
const ICONS: Record<string, string> = {
  m: "M4 20h4L19 9l-4-4L4 16z",
  a: "M12 5v14M5 12h14",
  d: "M5 12h14",
  r: "M5 12h14m-5-5 5 5-5 5",
  u: "M12 5v9m0 4v1",
  local: "M4 6h16v10H4zM2 19h20",
  remote: "M7 18a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 9a4.5 4.5 0 0 1 .5 9z",
  tag: "M3 12V4h8l10 10-8 8zM7.5 8.5h.01",
  check: "M5 12l5 5L20 7",
  branch: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9",
  stash: "M3 4h18v4H3zM5 8v12h14V8M10 12h4",
  worktree: "M8 19a4 4 0 0 1-2.24-7.32A3.5 3.5 0 0 1 9 6.03V6a3 3 0 1 1 6 0v.04a3.5 3.5 0 0 1 3.24 5.65A4 4 0 0 1 16 19zM12 19v3",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01",
  error: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM15 9l-6 6M9 9l6 6",
  folder: "M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z",
  folderOpen: "M3 18.5v-12A1.5 1.5 0 0 1 4.5 5H9l2 2.5h7A1.5 1.5 0 0 1 19.5 9v1.5M3 18.5l2.6-7A1.5 1.5 0 0 1 7 10.5h14l-2.8 8.5a1.5 1.5 0 0 1-1.4 1H4.5A1.5 1.5 0 0 1 3 18.5z",
  globe: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z",
  home: "M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 22V12h6v10",
  repo: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z",
  eyeOff: "M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.1 4M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 5.4-1.6",
};
const SORTS: Record<string, string> = { "": "A–Z", desc: "Z–A", status: "Status" };
// how Pull reconciles a diverged branch, by git_op's pull argument
const PULLS: Record<string, string> = { "": "fast-forward if possible", "ff-only": "fast-forward only", rebase: "rebase" };
const hue = (s: string) => [...s].reduce((a, ch) => a + ch.charCodeAt(0), 0) % COLORS.length;
// each author's sprite is one <symbol> in #sprites, which every avatar of theirs uses
const spriteIds = new Map<string, string>();
function spriteId(name: string) {
  let id = spriteIds.get(name);
  if (id) return id;
  spriteIds.set(name, (id = `av-${spriteIds.size}`));
  const { cells, hue: tint } = sprite(name);
  const d = cells.flatMap((row, r) => row.map((on, c) => (on ? `M${c + 1} ${r + 1}h1v1h-1z` : ""))).join("");
  $("sprites").insertAdjacentHTML(
    "beforeend",
    `<symbol id="${id}" viewBox="0 0 9 9"><circle cx="4.5" cy="4.5" r="4.5" fill="hsl(${tint},30%,20%)"/><path d="${d}" fill="hsl(${tint},75%,65%)"/></symbol>`,
  );
  return id;
}
const avatarSvg = (name: string, cls = "") => `<svg class="${cls}" viewBox="0 0 9 9"><use href="#${spriteId(name)}"/></svg>`;
const esc = (s: string) => s.replace(/[<>&"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });
const dayFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "short" });

let tabs: Tab[] = [];
let active = 0;
let repo = "";
let commits: Commit[] = [];
let st: Status | null = null;
let refs: Refs = { refs: [], stashes: [], remotes: [], worktrees: [] };
let selected = ["WIP"];
let anchor = "";
let rangeSel = false;
let stashView: Stash | null = null;
// the merge, rebase... in progress, and the step whose message the commit box holds
let opInfo: OpInfo | null = null;
let opStep = "";
let logKey = "", refsKey = "";
let panelSeq = 0;
let cur: { kind: Kind; f: Change; c?: Commit; orig: Blob; mod: Blob; dirty: boolean } | null = null;
let diffEditor: Monaco.editor.IStandaloneDiffEditor | null = null;
// hunk header bars, as view zone ids per side
let bars: { mod: string[]; orig: string[]; nodes: HTMLElement[] } = { mod: [], orig: [], nodes: [] };
let hunks: C4[] = [];
let lastSide: "orig" | "mod" = "mod";
let seq = 0;
let editing = "";
let hiddenSet = new Set<string>();
let hits: string[] = [];
let hit = -1;
// the graph rows and their lane colors, drawn by chunks: only those near the view are in the DOM
let shown: Commit[] = [];
let rowColors: string[] = [];
let chunks: HTMLElement[] = [];
let laneW = 0;
let laid: { width: number; nodes: number[]; edges: { row: number; lane: number; toRow: number; toLane: number; via: number }[] } = { width: 0, nodes: [], edges: [] };
let fileQuery = "";
// tree folders start shut; Expand all flips the default, a click flips one folder
let treeOpen = false;
const flipped = new Set<string>();
// each file list's files in display order, folded ones included, and how to unfold one
const fileLists = new Map<HTMLElement, { order: Change[]; reveal: (path: string) => void }>();
const terms = new Map<Tab, Term>();
let termIdle = 0;

const $ = (id: string) => document.getElementById(id)!;
const input = (id: string) => $(id) as HTMLInputElement;
const basename = (p: string) => p.split("/").pop() || p;
// names like WORKTREE stay whole
const short = (hash: string) => (/^[0-9a-f]{8,}$/.test(hash) ? hash.slice(0, 7) : hash);

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...kids);
  return el;
}

function store(key: string, value?: string) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {}
  return value ?? null;
}

function say(msg: string, err = false) {
  // errors pop up, the status bar keeps the quiet news
  if (err) return toast("Error", msg + hint(msg), "err");
  const s = $("status");
  s.textContent = msg.replace(/\s*\n\s*/g, " · ");
  s.title = msg;
}

const joinMsg = (summary: string, desc: string) => (desc.trim() ? `${summary.trim()}\n\n${desc.trim()}` : summary.trim());

function splitMsg(msg: string) {
  const nl = msg.indexOf("\n");
  return nl < 0 ? [msg, ""] : [msg.slice(0, nl), msg.slice(nl).trim()];
}

const getMsg = () => joinMsg(input("summary").value, input("desc").value);

function setMsg(msg: string) {
  [input("summary").value, input("desc").value] = splitMsg(msg);
  renderCommitBtn();
}

/** Characters left before the 72 column summary limit. */
function countLeft(summary: HTMLInputElement, out: HTMLElement) {
  const left = 72 - summary.value.length;
  out.textContent = String(left);
  out.classList.toggle("over", left < 0);
}

const svg = (d: string) => `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;
const headHash = () => commits.find(isHead)?.hash ?? "";

const run = <T>(cmd: string, args: Record<string, unknown> = {}) => invoke<T>(cmd, { repo, ...args });

/** Run git op `name`; a pair passes a second argument (new name, start point, remote branch). */
async function op(name: string, arg: string | [string, string] = "", record = true) {
  const [arg1, arg2] = Array.isArray(arg) ? arg : [arg, ""];
  const tab = tabs[active], branch = st?.branch ?? "", head = headHash();
  say(`${name}…`);
  document.body.classList.add("busy");
  let ok = true;
  try {
    const out = await run<string>("git_op", { op: name, arg: arg1, arg2 });
    // pre-commit's report, "name.....Passed": proof the hooks ran, worth a toast
    const hook = (l: string) => l.match(/^(.+?)\.{3,}(?:\(.*\))?(Passed|Skipped)$/);
    const hooks = out.split("\n").flatMap((l) => {
      const m = hook(l);
      return m ? [m] : [];
    });
    // git's own last word, not pre-commit's notes about stashing
    const last = out.trim().split("\n").filter((l) => !hook(l) && !/^\[(INFO|WARNING)\]/.test(l)).pop()?.trim() || `${name}: done`;
    say(last);
    if (hooks.length) {
      const passed = hooks.filter((m) => m[2] === "Passed").length;
      const lines = hooks.map((m) => `${m[2] === "Passed" ? "✓" : "–"} ${m[1]}${m[2] === "Passed" ? "" : " (skipped)"}`);
      toast(`Hooks passed: ${passed} ran, ${hooks.length - passed} skipped`, lines.join("\n"), "info");
    }
    // what the server says on push (pull request links, warnings) deserves more than the status bar
    const remote = out.split("\n").flatMap((l) => (l.startsWith("remote:") && l.slice(7).trim() ? [l.slice(7).trim()] : []));
    const upstream = refs.refs.find((r) => r.name === `refs/heads/${branch}`)?.upstream ?? "";
    const done = DONE[name]?.(arg1, arg2, branch, upstream);
    // git said nothing: the title is all there is
    if (done) toast(done, remote.length ? remote.join("\n") : out.trim() ? last : "", "info");
    else if (remote.length) toast("Message from the remote", remote.join("\n"), "info");
  } catch (e) {
    const msg = String(e);
    const what = name === "push-upstream" ? "Push" : name[0].toUpperCase() + name.slice(1).replace(/-/g, " ");
    const onBranch = /^(push|pull)/.test(name) && branch ? `: ${branch}` : "";
    // stopping on conflicts is no failure: the WIP panel takes over
    const conflicts = msg.split("\n").filter((l) => l.startsWith("CONFLICT"));
    if (conflicts.length) {
      toast(`${what} stopped on conflicts`, conflicts.join("\n"), "info");
      stashView = null;
      selected = [(anchor = "WIP")];
    } else toast(`${what} failed${onBranch}`, msg + hint(msg), "err");
    say(`${what} ${conflicts.length ? "stopped on conflicts" : "failed"}`);
    ok = false;
  }
  document.body.classList.remove("busy");
  await refresh();
  if (ok && record && UNDOABLE.has(name) && tab === tabs[active]) {
    const step: Step = { op: name, branch: [branch, st?.branch ?? ""], head: [head, headHash()] };
    if (step.head.every(Boolean) && (step.head[0] !== step.head[1] || step.branch[0] !== step.branch[1])) {
      tab.undo.push(step);
      tab.redo = [];
      renderToolbar();
    }
  }
  return ok;
}

/** A next step for the failures with a known cause. */
function hint(msg: string) {
  if (/could not read Username|Authentication failed|terminal prompts disabled/.test(msg))
    return "\n\nThis https remote needs credentials krill can use: run `gh auth setup-git` once, or switch the remote to ssh.";
  return "";
}

/** A pop-up in the corner: errors stay until dismissed, info fades out. */
function toast(title: string, body: string, kind: "err" | "info") {
  const dismiss = () => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 300);
  };
  const el = h(
    "div",
    { className: `toast ${kind}` },
    h("div", { className: "band", innerHTML: svg(kind === "err" ? ICONS.error : ICONS.info) }),
    h("div", { className: "t-body" }, h("b", { textContent: title }), h("pre", {}, ...linkify(body))),
    h("button", { className: "x", textContent: "×", title: "Dismiss", onclick: dismiss }),
  );
  $("toasts").append(el);
  // a short stack: the oldest goes
  while ($("toasts").children.length > 4) $("toasts").firstElementChild!.remove();
  if (kind === "info") setTimeout(dismiss, 10000);
}

/** Text with its web links clickable. */
function linkify(text: string) {
  return text
    .split(/(https?:\/\/[^\s'"<>]+)/)
    .map((part, i) => (i % 2 ? h("a", { textContent: part, onclick: () => invoke("open_url", { url: part }).catch((e) => say(String(e), true)) }) : part));
}

const pull = () => op("pull", store("pull") ?? "");

/** The Pull modes under the toolbar's caret: picking one makes it the default and pulls. */
function pullMenu(e: MouseEvent) {
  e.stopPropagation();
  const mode = store("pull") ?? "", r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  showMenu(
    Object.entries(PULLS).map(([k, label]): MenuItem => [`Pull, ${label}${k === mode ? "  ✓" : ""}`, () => (store("pull", k), paintPull(), pull())]),
    r.left,
    r.bottom,
  );
}

const paintPull = () => ($("pull").title = `Pull, ${PULLS[store("pull") ?? ""]}`);

/** Push; a branch without upstream first asks where to, in a banner. */
function push() {
  const branch = st?.branch ?? "";
  if (!branch || refs.refs.find((r) => r.name === `refs/heads/${branch}`)?.upstream) return op("push");
  if (!refs.remotes.length) return toast(`Push failed: ${branch}`, "This repository has no remote.", "err");
  const remote = h("select", {}, ...refs.remotes.map((r) => h("option", { value: r, textContent: r })));
  remote.value = refs.remotes.includes("origin") ? "origin" : refs.remotes[0];
  const name = h("input", { value: branch, spellcheck: false });
  const close = () => ($("banner").hidden = true);
  const submit = () => {
    if (!name.value.trim()) return;
    close();
    op("push-upstream", [remote.value, name.value.trim()]);
  };
  name.onkeydown = (e) => {
    if (e.key === "Enter") submit();
  };
  $("banner").replaceChildren(
    h("span", { textContent: `Where should "${branch}" push to and pull from?` }),
    remote,
    h("span", { textContent: "/" }),
    name,
    h("button", { className: "primary", textContent: "Push", onclick: submit }),
    h("button", { textContent: "Cancel", onclick: close }),
  );
  $("banner").hidden = false;
  name.select();
}

/** Undo (or redo) the last HEAD move krill made, if nothing moved HEAD since. */
async function walk(back: boolean) {
  const t = tabs[active];
  const step = (back ? t.undo : t.redo).pop();
  if (!step) return;
  const [from, to] = back ? [1, 0] : [0, 1];
  if (headHash() !== step.head[from] || (st?.branch ?? "") !== step.branch[from]) {
    t.undo = [];
    t.redo = [];
    renderToolbar();
    return say(`HEAD moved outside krill, nothing to ${back ? "undo" : "redo"}`, true);
  }
  let ok;
  if (step.file) {
    const [path, ...text] = step.file;
    const now = await run<Blob>("blob", { at: "WORKTREE", path });
    if ((now.exists ? now.text : null) !== text[from]) {
      renderToolbar();
      return say(`${path} changed since, nothing to ${back ? "undo" : "redo"}`, true);
    }
    const write = text[to] === null ? run("delete_file", { path }) : run("write_file", { path, text: text[to] });
    ok = await write.then(() => true, (e) => (say(String(e), true), false));
    await refresh();
  } else
    ok =
      step.branch[0] !== step.branch[1]
        ? await op("checkout", step.branch[to] || step.head[to], false)
        : await op(KEEP_INDEX.has(step.op) ? "reset-soft" : "reset-keep", step.head[to], false);
  (ok === back ? t.redo : t.undo).push(step);
  renderToolbar();
}

async function refresh() {
  const r = repo;
  if (!r) return;
  try {
    const [s, log, rf] = await Promise.all([run<Status>("status"), run<Commit[]>("log", { limit: LOG_LIMIT, hide: [...hiddenRemotes().map((r) => `refs/remotes/${r}/*`), ...hiddenBranches().filter((k) => k.startsWith("refs/"))] }), run<Refs>("refs")]);
    if (r !== repo) return;
    st = s;
    refs = rf;
    opInfo = s.state ? await run<OpInfo>("op_info").catch(() => null) : null;
    if (r !== repo) return;
    // resolved or aborted elsewhere: nothing left to merge
    if (merging && !s.unstaged.some((f) => f.path === merging!.f.path && isConflict(f))) closeMerge(true);
    const step = opInfo ? JSON.stringify([opInfo.state, opInfo.step, opInfo.message]) : "";
    if (step !== opStep) {
      if (opStep || step) setMsg(opInfo?.message ?? "");
      opStep = step;
    }
    // per list: staging a file moves it, and a resolved conflict changes the WIP row
    const key = JSON.stringify([log.map((c) => [c.hash, c.refs]), s.staged.length, s.unstaged.length, conflictCount(), rf.stashes.map((x) => x.hash)]);
    if (key !== logKey) {
      logKey = key;
      commits = log;
      selected = selected.filter((x) => x === "WIP" || commits.some((c) => c.hash === x));
      if (!selected.length && !stashView) selected = ["WIP"];
      // nothing to commit: open on HEAD, not on an empty WIP panel
      if (selected[0] === "WIP" && !s.staged.length && !s.unstaged.length && !opInfo && headHash()) selected = [(anchor = headHash())];
      renderGraph();
    }
    if (stashView && !rf.stashes.some((x) => x.hash === stashView!.hash)) stashView = null;
    const rk = JSON.stringify([rf, s.branch]);
    if (rk !== refsKey) {
      refsKey = rk;
      renderSide();
    }
    renderToolbar();
    await renderPanel();
    if (cur) await reloadDiff();
  } catch (e) {
    if (r !== repo) return;
    // the folder went away under the tab, like a removed worktree: close it rather than fail on every refresh
    if (!(await exists(r))) {
      if (r !== repo) return;
      toast(`Closed ${tabName(tabs[active])}`, `${r} no longer exists. Removed from the recent list.`, "info");
      forgetRecent(r);
      return closeTab(active);
    }
    say(String(e), true);
  }
}

const exists = (path: string) => invoke("repo_root", { path }).then(() => true, () => false);

function renderToolbar() {
  if (!st) return;
  $("branch").textContent = st.branch || "detached HEAD";
  $("repo-ico").innerHTML = svg(tabs[active].worktree ? ICONS.worktree : ICONS.repo);
  $("branch-ico").innerHTML = svg(ICONS.branch);
  $("behind").textContent = st.behind ? `↓${st.behind}` : "";
  $("ahead").textContent = st.ahead ? `↑${st.ahead}` : "";
  $("opstate").hidden = !st.state;
  $("opname").textContent = st.state;
  const { undo, redo } = tabs[active];
  const u = $("undo") as HTMLButtonElement, r = $("redo") as HTMLButtonElement;
  u.disabled = !undo.length;
  r.disabled = !redo.length;
  u.title = undo.length ? `Undo ${undo[undo.length - 1].op} (Ctrl+Z)` : "Nothing to undo";
  r.title = redo.length ? `Redo ${redo[redo.length - 1].op} (Ctrl+Shift+Z)` : "Nothing to redo";
}

/* tabs and home */

const aliases = (): Record<string, string> => JSON.parse(store("aliases") ?? "{}");
const tabName = (t: Tab) => (t.repo ? (aliases()[t.repo] ?? basename(t.repo)) : "Home");
// closed this session, for Ctrl+Shift+T
const closedTabs: string[] = [];

function saveTabs() {
  store("tabs", JSON.stringify(tabs.map((t) => t.repo)));
  store("active", String(active));
}

function newTab(repo: string): Tab {
  const t: Tab = { repo, selected: ["WIP"], msg: "", scroll: 0, undo: [], redo: [], worktree: false };
  // a linked worktree's .git is a file
  if (repo) invoke<boolean>("is_file", { path: `${repo}/.git` }).then((w) => w && ((t.worktree = true), renderTabs()));
  return t;
}
const recentRepos = (): string[] => JSON.parse(store("recent") ?? "[]");
const forgetRecent = (r: string) => store("recent", JSON.stringify(recentRepos().filter((x) => x !== r)));

function renderTabs() {
  $("tablist").replaceChildren(
    ...tabs.map((t, i) =>
      h(
        "div",
        {
          className: `tab${i === active ? " on" : ""}`,
          title: t.repo,
          onclick: () => i !== active && switchTab(i),
          onpointerdown: (e: PointerEvent) => dragTab(e, i),
          onauxclick: (e: MouseEvent) => e.button === 1 && closeTab(i),
          oncontextmenu: (e: MouseEvent) => popup(e, tabMenu(i)),
        },
        ico(t.repo ? (t.worktree ? ICONS.worktree : ICONS.repo) : ICONS.home),
        tabName(t),
        h("button", { className: "x", textContent: "×", title: "Close (Ctrl+W)", onclick: (e: Event) => (e.stopPropagation(), closeTab(i)) }),
      ),
    ),
  );
}

/** Drag tab `i` sideways to move it: it swaps with a neighbour once the pointer passes that neighbour's middle. */
function dragTab(e: PointerEvent, i: number) {
  if (e.button !== 0 || (e.target as HTMLElement).closest(".x, input")) return;
  const x0 = e.clientX;
  let at = i, moved = false;
  const move = (m: PointerEvent) => {
    if (!moved && Math.abs(m.clientX - x0) < 5) return;
    moved = true;
    const els = [...$("tablist").children] as HTMLElement[];
    const to = els.filter((el, k) => k !== at && (({ left, width }) => left + width / 2 < m.clientX)(el.getBoundingClientRect())).length;
    if (to !== at) {
      const on = tabs[active];
      tabs.splice(to, 0, ...tabs.splice(at, 1));
      active = tabs.indexOf(on);
      at = to;
      renderTabs();
    }
    $("tablist").children[at].classList.add("drag");
  };
  const up = () => {
    removeEventListener("pointermove", move);
    $("tablist").children[at]?.classList.remove("drag");
    if (moved) saveTabs();
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up, { once: true });
}

async function switchTab(i: number, save = true) {
  if (save && cur?.dirty && !(await ask(`Drop unsaved edits to ${cur.f.path}?`, "Drop edits"))) return;
  if (save) Object.assign(tabs[active], { selected, msg: getMsg(), scroll: $("graph").scrollTop });
  closeHistory();
  active = i;
  const t = tabs[active];
  repo = t.repo;
  selected = t.selected;
  anchor = selected[0];
  rangeSel = false;
  stashView = null;
  setMsg(t.msg);
  commits = [];
  st = null;
  logKey = refsKey = opStep = "";
  shown = [];
  chunks = [];
  $("rows").replaceChildren();
  $("side").replaceChildren();
  saveTabs();
  renderTabs();
  document.body.classList.toggle("home", !repo);
  $("home").hidden = !!repo;
  getCurrentWindow().setTitle(repo ? `Git Krill · ${tabName(t)}` : "Git Krill");
  showTerm(false);
  if (!repo) return renderRecent();
  $("repo-name").textContent = tabName(t);
  await refresh();
  $("graph").scrollTop = t.scroll;
  autoFetch();
}

async function closeTab(i: number) {
  if (i === active && cur?.dirty && !(await ask(`Drop unsaved edits to ${cur.f.path}?`, "Drop edits"))) return;
  dropTerm(tabs[i]);
  if (tabs[i].repo) closedTabs.push(tabs[i].repo);
  tabs.splice(i, 1);
  if (!tabs.length) tabs.push(newTab(""));
  if (i === active) return switchTab(Math.min(i, tabs.length - 1), false);
  if (i < active) active--;
  saveTabs();
  renderTabs();
}

/** Close every tab `keep` refuses, from tab `i` which stays and becomes active. */
async function closeTabs(i: number, keep: (k: number) => boolean) {
  const kept = tabs[i];
  if (i !== active) await switchTab(i);
  if (tabs[active] !== kept) return;
  const gone = tabs.filter((_, k) => !keep(k));
  for (const t of gone) {
    dropTerm(t);
    if (t.repo) closedTabs.push(t.repo);
  }
  tabs = tabs.filter((_, k) => keep(k));
  active = tabs.indexOf(kept);
  saveTabs();
  renderTabs();
}

function tabMenu(i: number): MenuItem[] {
  const t = tabs[i];
  const items: MenuItem[] = [
    ["Close tab", () => closeTab(i)],
    ["Close other tabs", () => closeTabs(i, (k) => k === i)],
    ["Close tabs to the right", () => closeTabs(i, (k) => k <= i)],
  ];
  if (t.repo) items.push(["Rename tab…", () => renameTab(i)]);
  if (closedTabs.length) items.push(["Reopen closed tab (Ctrl+Shift+T)", reopenTab]);
  return items;
}

/** Rename a tab in place: Enter or leaving the field keeps it, Esc cancels, empty resets. */
function renameTab(i: number) {
  const t = tabs[i];
  let done = false;
  const box = h("input", { className: "tab-alias", value: tabName(t), spellcheck: false, onclick: (e: Event) => e.stopPropagation() });
  const finish = (keep: boolean) => {
    if (done) return;
    done = true;
    const all = aliases(), name = box.value.trim();
    if (keep && name && name !== basename(t.repo)) all[t.repo] = name;
    else if (keep) delete all[t.repo];
    store("aliases", JSON.stringify(all));
    renderTabs();
    if (t === tabs[active]) {
      $("repo-name").textContent = tabName(t);
      getCurrentWindow().setTitle(`Git Krill · ${tabName(t)}`);
    }
  };
  box.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter" || e.key === "Escape") finish(e.key === "Enter");
  };
  box.onblur = () => finish(true);
  ($("tablist").children[i] as HTMLElement).replaceChildren(box);
  box.select();
}

function reopenTab() {
  const r = closedTabs.pop();
  if (r) openRepo(r);
}

function renderTabHits() {
  const q = input("tab-q").value.toLowerCase();
  $("tab-hits").replaceChildren(
    ...tabs.flatMap((t, i) =>
      q && !`${tabName(t)} ${t.repo}`.toLowerCase().includes(q)
        ? []
        : [
            h(
              "div",
              { className: `tab-hit${i === active ? " on" : ""}`, onclick: () => (($("tab-search").hidden = true), i !== active && switchTab(i)) },
              h("b", { textContent: tabName(t) }),
              h("small", { textContent: t.repo }),
              h("button", { textContent: "×", title: "Close", onclick: (e: Event) => (e.stopPropagation(), closeTab(i), renderTabHits()) }),
            ),
          ],
    ),
  );
}

function addTab() {
  tabs.push(newTab(""));
  switchTab(tabs.length - 1);
}

/** Open `path` in its existing tab, the current Home tab, or a new tab. */
async function openRepo(path: string) {
  let root: string;
  try {
    root = await invoke<string>("repo_root", { path });
  } catch (e) {
    // a recent repository that moved or was deleted leaves the list
    if (!recentRepos().includes(path)) {
      say(String(e), true);
      return false;
    }
    forgetRecent(path);
    if (!repo) renderRecent();
    toast(`Removed ${basename(path)} from the recent list`, `${path} cannot be opened:\n${e}`, "info");
    return false;
  }
  // ten fit on the home screen
  store("recent", JSON.stringify([root, ...recentRepos().filter((r) => r !== root)].slice(0, 10)));
  const i = tabs.findIndex((t) => t.repo === root);
  if (i >= 0) {
    // a Home tab that only led to an already open repo has no reason to stay
    const home = tabs[active].repo ? -1 : active;
    await switchTab(i);
    if (home >= 0) closeTab(home);
  } else if (tabs[active].repo) {
    tabs.push(newTab(root));
    await switchTab(tabs.length - 1);
  } else {
    tabs[active] = newTab(root);
    await switchTab(active, false);
  }
  return true;
}

function renderRecent() {
  const forget = (r: string) => (e: Event) => {
    e.stopPropagation();
    forgetRecent(r);
    renderRecent();
  };
  $("recent").replaceChildren(
    ...recentRepos().slice(0, 10).map((r) =>
      h(
        "div",
        { className: "recent", title: r, onclick: () => openRepo(r) },
        h("b", { textContent: basename(r) }),
        h("small", { textContent: r }),
        h("button", { textContent: "×", title: "Forget", onclick: forget(r) }),
      ),
    ),
  );
}

async function pickDir(title: string) {
  const p = await openDialog({ directory: true, title });
  return typeof p === "string" ? p : null;
}

/* branches sidebar */

function trackLabel(track: string) {
  if (track === "[gone]") return "gone";
  const ahead = track.match(/ahead (\d+)/)?.[1], behind = track.match(/behind (\d+)/)?.[1];
  return [ahead && `↑${ahead}`, behind && `↓${behind}`].filter(Boolean).join(" ");
}

/** The eye at a sidebar row's left edge: hides `key` (a ref, or a stash's hash) from the graph, or shows it again. */
function eye(key: string, hidden: boolean, toggle = () => toggleHidden(key)) {
  return h("button", {
    className: `eye${hidden ? " on" : ""}`,
    title: hidden ? "Show in the graph" : "Hide from the graph",
    innerHTML: svg(hidden ? ICONS.eyeOff : ICONS.eye),
    // the row under it would jump, fold or check out
    onclick: (e: Event) => (e.preventDefault(), e.stopPropagation(), toggle()),
    ondblclick: (e: Event) => e.stopPropagation(),
  });
}

/** A sidebar row; `hide` is what its eye keeps out of the graph, none on the checked out branch. */
function sideItem(label: string, icon: string, hash: string, extra: string, cls: string, menu: MenuItem[], dbl?: () => unknown, hide?: string) {
  const hidden = !!hide && hiddenSet.has(hide);
  return h(
    "div",
    { className: `item ${cls}${hidden ? " hidden-ref" : ""}`, title: label, onclick: () => jumpTo(hash), ondblclick: dbl ?? null, oncontextmenu: (e: MouseEvent) => popup(e, menu) },
    ...(cls === "current" ? [h("span", { className: "ico check", innerHTML: svg(ICONS.check) })] : hide ? [eye(hide, hidden)] : []),
    ico(ICONS[icon]),
    h("span", { className: "label", textContent: label }),
    h("small", { textContent: extra }),
  );
}

function renderSide() {
  // what the user folded stays folded, per repository
  const r = repo, folds = sideFolds();
  hiddenSet = new Set([...hiddenRemotes(), ...hiddenBranches()]);
  const section = (key: string, title: string, items: HTMLElement[], open: boolean, icon = "") => {
    const count = h("span", { className: "n", textContent: String(items.length) });
    const d = h("details", { open: folds[key] ?? open }, h("summary", {}, ...(icon ? [ico(ICONS[icon])] : []), title, count), ...items);
    d.ontoggle = () => r === repo && store(`side:${r}`, JSON.stringify({ ...sideFolds(), [key]: d.open }));
    d.dataset.key = key;
    return d;
  };
  const local: HTMLElement[] = [], tags: HTMLElement[] = [], remotes = new Map<string, HTMLElement[]>();
  for (const r of refs.refs) {
    if (r.name.startsWith("refs/heads/")) {
      const name = r.name.slice(11), current = name === st?.branch;
      local.push(sideItem(name, "branch", r.hash, trackLabel(r.track), current ? "current" : "", branchMenu(name, false), () => current || checkoutBranch(name, false), current ? undefined : r.name));
    } else if (r.name.startsWith("refs/remotes/")) {
      const full = r.name.slice(13), slash = full.indexOf("/");
      const items = remotes.get(full.slice(0, slash)) ?? [];
      items.push(sideItem(full.slice(slash + 1), "branch", r.hash, "", "", branchMenu(full, true), () => checkoutBranch(full, true), r.name));
      remotes.set(full.slice(0, slash), items);
    } else {
      const name = r.name.slice(10);
      tags.push(sideItem(name, "tag", r.hash, "", "", tagMenu(name), undefined, r.name));
    }
  }
  const stashes = refs.stashes.map((s) =>
    h(
      "div",
      {
        className: `item${hiddenSet.has(s.hash) ? " hidden-ref" : ""}`,
        title: `${s.name}: ${s.subject}`,
        onclick: () => showStash(s, true),
        oncontextmenu: (e: MouseEvent) => popup(e, stashMenu(s)),
      },
      eye(s.hash, hiddenSet.has(s.hash)),
      ico(ICONS.stash),
      h("span", { className: "label", textContent: s.subject }),
    ),
  );
  const worktrees = refs.worktrees.map((w, k) => {
    const here = w === thisWorktree();
    const extra = w.prunable ? "gone" : w.locked ? "locked" : k ? "" : "main";
    const open = () => (w.prunable ? prune(w) : openWorktree(w.path));
    const el = sideItem(w.branch || `detached at ${short(w.head)}`, "worktree", w.head, extra, here ? "current" : "", worktreeMenu(w, k === 0), () => here || open());
    el.title = w.path;
    return el;
  });
  // a linked worktree names its main repository first
  const main = refs.worktrees[0];
  $("repo-name").textContent = !main || main === thisWorktree() ? tabName(tabs[active]) : `${basename(main.path)} › ${tabName(tabs[active])}`;
  $("repo-name").title = repo;
  $("side").replaceChildren(
    section("local", "Local", local, true, "local"),
    section("remote", "Remote", [...remotes].map(([name, items]) => remoteSection(section(`remote/${name}`, name, items, false, "globe"), name)), true, "remote"),
    // the checkout alone is no list of worktrees
    section("worktrees", "Worktrees", worktrees.length > 1 ? worktrees : [], false, "worktree"),
    section("tags", "Tags", tags, false, "tag"),
    section("stashes", "Stashes", stashes, false, "stash"),
  );
}

/** The worktree other than this one that has `branch` checked out, its folder still there. */
// this checkout's entry: the repo tool's checkouts list their git dir, not their folder, as the main worktree
const thisWorktree = () => refs.worktrees.find((w) => w.path === repo) ?? refs.worktrees[0];
const worktreeOf = (branch: string) => refs.worktrees.find((w) => w.branch === branch && w !== thisWorktree() && !w.prunable);

const prune = (w: Worktree) =>
  ask(`The folder of ${basename(w.path)} is gone. Prune it from the worktree list?`, "Prune").then((ok) => ok && op("worktree-prune"));

function worktreeMenu(w: Worktree, main: boolean): MenuItem[] {
  const here = w.path === repo;
  return [
    ...(here || w.prunable ? [] : ([["Open worktree", () => openWorktree(w.path)], ["Open in a new tab", () => openRepo(w.path)]] as MenuItem[])),
    ["Copy path", () => copy(w.path)],
    ...(w.prunable
      ? ([["Prune: its folder is gone", () => prune(w)]] as MenuItem[])
      : main || here
        ? []
        : ([["Remove worktree…", () => removeWorktree(w)]] as MenuItem[])),
  ];
}

/** Show worktree `path` in this tab, or switch to the tab that has it. */
async function openWorktree(path: string) {
  const i = tabs.findIndex((t) => t.repo === path);
  if (i >= 0) return switchTab(i);
  if (!(await exists(path))) return say(`${path} no longer exists`, true);
  if (cur?.dirty && !(await ask(`Drop unsaved edits to ${cur.f.path}?`, "Drop edits"))) return;
  // the shell ran in the old folder
  dropTerm(tabs[active]);
  tabs[active] = newTab(path);
  await switchTab(active, false);
}

/** `git worktree remove`, forced after a warning when it has changes; its branch can go too. */
async function removeWorktree(w: Worktree) {
  const s = await invoke<Status>("status", { repo: w.path }).catch(() => null);
  const dirty = !!s && s.staged.length + s.unstaged.length > 0;
  const remove = (andBranch: boolean) => async () => {
    if ((await op(dirty ? "worktree-force-remove" : "worktree-remove", w.path)) && andBranch) deleteBranch(w.branch, "");
  };
  dialog(
    dirty ? `${basename(w.path)} has uncommitted changes. Remove it and lose them?` : `Remove worktree ${basename(w.path)}? Its folder is deleted, its branch stays.`,
    [],
    dirty ? "Force remove" : "Remove",
    remove(false),
    w.branch ? [[`Remove and delete ${w.branch}`, remove(true)]] : [],
  );
}

/** Eye toggle and menu on a remote's folder in the sidebar. */
function remoteSection(d: HTMLElement, name: string) {
  const hidden = hiddenRemotes().includes(name);
  const sum = d.querySelector("summary")!;
  sum.prepend(eye(name, hidden, () => toggleRemote(name)));
  sum.oncontextmenu = (e) =>
    popup(e, [
      [`Fetch ${name}`, () => op("fetch-remote", name)],
      [hidden ? `Show ${name} in the graph` : `Hide ${name} from the graph`, () => toggleRemote(name)],
      [`Edit ${name}…`, () => editRemote(name)],
      null,
      [`Copy link to ${name}`, async () => copy(await webUrl(name))],
    ]);
  d.classList.toggle("hidden-remote", hidden);
  return d;
}

async function editRemote(name: string) {
  const urls = await run<{ fetch: string; push: string }>("remote_urls", { name }).catch((e) => (say(String(e), true), null));
  if (!urls) return;
  const fields: [string, string][] = [["Name", name], ["Pull URL", urls.fetch], ["Push URL", urls.push]];
  dialog("Edit remote", fields, "Save", async ([newName, fetch, push]) => {
    try {
      await run("edit_remote", { name, newName, fetch, push });
      say(`remote ${newName} saved`);
      // a hidden remote stays hidden under its new name
      if (newName !== name) store(`hide:${repo}`, JSON.stringify(hiddenRemotes().map((r) => (r === name ? newName : r))));
    } catch (e) {
      say(String(e), true);
    }
    logKey = refsKey = "";
    await refresh();
  });
}

/** A small form over the app; `save` gets the trimmed field values in order. */
// what closing the open dialog without its action means, if anything
let dialogCancel: (() => unknown) | null = null;

/** Hide the dialog: Cancel, its ×, Esc and a click beside it all end here. */
function closeDialog() {
  $("dialog").hidden = true;
  const cancel = dialogCancel;
  dialogCancel = null;
  cancel?.();
}

/** A dialog of `fields` ([label, value, input type]); a password is kept as typed, the rest trimmed. */
function dialog(
  title: string,
  fields: [string, string, string?][],
  action: string,
  save: (values: string[]) => unknown,
  more: [string, () => unknown][] = [],
  cancel?: () => unknown,
) {
  const inputs = fields.map(([, value, type = "text"]) => h("input", { value, type, spellcheck: false }));
  const close = () => {
    dialogCancel = null;
    $("dialog").hidden = true;
  };
  const submit = () => {
    close();
    save(inputs.map((i) => (i.type === "password" ? i.value : i.value.trim())));
  };
  dialogCancel = cancel ?? null;
  for (const i of inputs) {
    i.onkeydown = (e) => {
      if (e.key === "Enter") submit();
    };
  }
  $("dialog").replaceChildren(
    h(
      "div",
      { className: "dlg" },
      h("div", { className: "dlg-head" }, h("b", { textContent: title }), h("button", { className: "x", textContent: "×", title: "Close (Esc)", onclick: closeDialog })),
      ...fields.flatMap(([label], k) => [h("label", { textContent: label }), inputs[k]]),
      h(
        "div",
        { className: "dlg-actions" },
        h("button", { textContent: "Cancel", onclick: closeDialog }),
        ...more.map(([label, fn]) => h("button", { textContent: label, onclick: () => (close(), fn()) })),
        h("button", { className: "primary", textContent: action, onclick: submit }),
      ),
    ),
  );
  $("dialog").hidden = false;
  (inputs[0] ?? $("dialog").querySelector("button.primary")).focus();
}

/** Clone dialog: where to (typed or browsed, remembered), the URL, then the folder name, from the URL until edited. */
function cloneDialog() {
  const recent = recentRepos()[0] ?? "";
  const parent = h("input", { value: store("clone-dir") ?? recent.slice(0, recent.lastIndexOf("/")), spellcheck: false });
  const url = h("input", { spellcheck: false, placeholder: "git@host:org/repo.git or https://host/org/repo.git" });
  const name = h("input", { spellcheck: false });
  const at = h("span", { className: "clone-at" });
  const fullLabel = h("label", { textContent: "Full path" }), full = h("div", { className: "dlg-row" }, at, "/", name);
  const go = h("button", { className: "primary", textContent: "Clone" });
  // a typed name sticks, an emptied one follows the URL again
  let named = false;
  const paint = () => {
    if (!named) name.value = repoName(url.value);
    at.textContent = parent.value.trim().replace(/\/+$/, "");
    at.title = at.textContent;
    fullLabel.hidden = full.hidden = !url.value.trim();
    go.disabled = !parent.value.trim() || !url.value.trim() || !name.value.trim();
  };
  parent.oninput = url.oninput = paint;
  name.oninput = () => ((named = !!name.value), paint());
  const close = () => ($("dialog").hidden = true);
  const submit = async () => {
    if (go.disabled) return;
    go.disabled = true;
    go.textContent = "Cloning…";
    try {
      const path = await invoke<string>("clone", { parent: parent.value.trim(), url: url.value.trim(), name: name.value.trim() });
      store("clone-dir", parent.value.trim());
      close();
      await openRepo(path);
    } catch (e) {
      say(String(e), true);
      go.textContent = "Clone";
      paint();
    }
  };
  for (const i of [parent, url, name]) i.onkeydown = (e) => void (e.key === "Enter" && submit());
  go.onclick = submit;
  const browse = async () => {
    const p = await pickDir("Clone into");
    if (p) (parent.value = p), paint();
  };
  $("dialog").replaceChildren(
    h(
      "div",
      { className: "dlg clone-dlg" },
      h("div", { className: "dlg-head" }, h("b", { textContent: "Clone a repository" }), h("button", { className: "x", textContent: "×", title: "Close (Esc)", onclick: close })),
      h("label", { textContent: "Where to clone to" }),
      h("div", { className: "dlg-row" }, parent, h("button", { textContent: "Browse…", onclick: browse })),
      h("label", { textContent: "URL" }),
      url,
      fullLabel,
      full,
      h("div", { className: "dlg-actions" }, h("button", { textContent: "Cancel", onclick: close }), go),
    ),
  );
  paint();
  $("dialog").hidden = false;
  url.focus();
}

// WebKitGTK's confirm() returns true without showing anything
const ask = (question: string, action: string) => new Promise<boolean>((done) => dialog(question, [], action, () => done(true), [], () => done(false)));

// ssh asking for a key's passphrase, or git for https credentials, while krill runs them
listen<string>("askpass", ({ payload: prompt }) => {
  const secret = /passphrase|password/i.test(prompt);
  const reply = (answer: string | null) => invoke("askpass_reply", { answer });
  dialog(/passphrase/i.test(prompt) ? "SSH key passphrase" : "Sign in", [[prompt, "", secret ? "password" : "text"]], "OK", ([v]) => reply(v), [], () => reply(null));
});

const hiddenRemotes = (): string[] => JSON.parse(store(`hide:${repo}`) ?? "[]");
// full ref names of the branches kept out of the graph
const hiddenBranches = (): string[] => JSON.parse(store(`hide-refs:${repo}`) ?? "[]");
const sideFolds = (): Record<string, boolean> => JSON.parse(store(`side:${repo}`) ?? "{}");

/** Show or hide `key` in the menus that offer it. */
const hideItem = (key: string): MenuItem => [hiddenBranches().includes(key) ? "Show in the graph" : "Hide from the graph", () => toggleHidden(key)];

function toggleHidden(ref: string) {
  const hidden = hiddenBranches();
  store(`hide-refs:${repo}`, JSON.stringify(hidden.includes(ref) ? hidden.filter((r) => r !== ref) : [...hidden, ref]));
  logKey = refsKey = "";
  refresh();
}

function toggleRemote(name: string) {
  const hidden = hiddenRemotes();
  store(`hide:${repo}`, JSON.stringify(hidden.includes(name) ? hidden.filter((r) => r !== name) : [...hidden, name]));
  logKey = refsKey = "";
  refresh();
}

/** Browser URL of a remote: git@host:org/repo.git, ssh://git@host:22/org/repo, https://user@host/org/repo.git. */
async function webUrl(remote: string) {
  const url = await run<string>("remote_url", { name: remote });
  const m = url.match(/^(?:\w+:\/\/)?(?:[^@/]+@)?([^:/]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/);
  return m ? `https://${m[1]}/${m[2]}` : url;
}

/** The remote links point at: the current branch's upstream, else the first remote. */
function linkRemote() {
  const up = refs.refs.find((r) => r.name === `refs/heads/${st?.branch}`)?.upstream;
  const names = refs.refs.filter((r) => r.name.startsWith("refs/remotes/")).map((r) => r.name.slice(13).split("/")[0]);
  return up ? up.split("/")[0] : (names[0] ?? "");
}

function jumpTo(hash: string) {
  if (!commits.some((c) => c.hash === hash)) return say(`${short(hash)} is older than the last ${LOG_LIMIT} commits`, true);
  stashView = null;
  selected = [hash];
  anchor = hash;
  rangeSel = false;
  paintSelection();
  showRow(hash, "center");
  renderPanel();
}

function showStash(s: Stash, scroll = false) {
  stashView = s;
  selected = [];
  anchor = s.hash;
  paintSelection();
  if (scroll) showRow(s.hash, "center");
  renderPanel();
}

const stashOf = (hash: string) => refs.stashes.find((s) => s.hash === hash);

function stashMenu(s: Stash): MenuItem[] {
  return [
    ["Apply stash", () => op("stash-apply", s.name)],
    ["Pop stash", () => op("stash-pop", s.name)],
    ["Drop stash", () => ask(`Drop stash "${s.subject}"? It cannot be undone.`, "Drop").then((ok) => ok && op("stash-drop", s.name))],
    null,
    ["Edit stash message…", () => dialog("Edit stash message", [["Message", s.subject]], "Save", ([m]) => m && op("stash-message", [s.name, m]))],
    hideItem(s.hash),
  ];
}

/* graph */

const isHead = (c: Commit) => c.refs.some((r) => r === "HEAD" || r.startsWith("HEAD -> "));

function renderGraph() {
  hiddenSet = new Set([...hiddenRemotes(), ...hiddenBranches()]);
  const n = st ? st.staged.length + st.unstaged.length : 0;
  const head = commits.find(isHead);
  const wip: Commit = { hash: "WIP", parents: head ? [head.hash] : [], author: "", time: 0, refs: [], subject: "// WIP", body: "" };
  // an operation in progress keeps the row: its controls live in the WIP panel
  const list = n || opInfo ? [wip, ...commits] : [...commits];
  // a stash hangs off its base commit
  for (const s of refs.stashes) {
    if (hiddenSet.has(s.hash)) continue;
    const at = list.findIndex((c) => c.hash === s.parents[0]);
    if (at >= 0) list.splice(at, 0, { hash: s.hash, parents: [s.parents[0]], author: "", time: 0, refs: [], subject: s.subject, body: "" });
  }
  laid = layoutGraph(list);
  // wide enough for its column title
  laneW = Math.max(laid.width * LANE + 10, 64);
  $("graph").style.setProperty("--graph-w", `${laneW}px`);
  shown = list;
  rowColors = list.map((_, i) => laneColor(laid.nodes[i]));
  chunks = Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, k) =>
    h("div", { className: "chunk", style: `height: ${Math.min(CHUNK, list.length - k * CHUNK) * ROW}px` }),
  );
  $("rows").replaceChildren(...chunks);
  drawRows();
  if (!$("find").hidden) markHits();
}

const laneX = (l: number) => l * LANE + LANE / 2 + 4;
const rowY = (r: number) => r * ROW + ROW / 2;
const laneColor = (l: number) => COLORS[l % COLORS.length];

/** The lanes of rows `from` to `to`: the edges crossing them, their dots and label links. */
function lanesSvg(from: number, to: number) {
  const X = laneX, Y = rowY, color = laneColor, list = shown;
  let svg = "";
  for (const e of laid.edges) {
    if (e.toRow < from || e.row >= to) continue;
    const pts = [[e.lane, e.row]];
    if (e.toRow - e.row > 1) {
      if (e.via !== e.lane) pts.push([e.via, e.row + 1]);
      if (e.via !== e.toLane) pts.push([e.via, e.toRow - 1]);
    }
    pts.push([e.toLane, e.toRow]);
    let d = `M${X(pts[0][0])} ${Y(pts[0][1])}`;
    for (let k = 1; k < pts.length; k++) {
      const [l0, r0] = pts[k - 1], [l1, r1] = pts[k];
      const ym = (Y(r0) + Y(r1)) / 2;
      d += l0 === l1 ? `L${X(l1)} ${Y(r1)}` : `C${X(l0)} ${ym} ${X(l1)} ${ym} ${X(l1)} ${Y(r1)}`;
    }
    const dash = list[e.row].hash === "WIP" || stashOf(list[e.row].hash) ? ' stroke-dasharray="3 3"' : "";
    svg += `<path d="${d}" stroke="${color(e.via)}"${dash}/>`;
  }
  // commits show their author, merges stay a small dot
  for (let i = from; i < to; i++) {
    const c = list[i], l = laid.nodes[i], at = `cx="${X(l)}" cy="${Y(i)}"`;
    if (c.hash === "WIP") svg += `<circle ${at} r="6" class="wip"/>`;
    else if (stashOf(c.hash))
      svg +=
        `<rect x="${X(l) - 9}" y="${Y(i) - 9}" width="18" height="18" rx="3" class="stash"/>` +
        `<svg x="${X(l) - 6}" y="${Y(i) - 6}" width="12" height="12" viewBox="0 0 24 24" class="stash"><path d="${ICONS.stash}"/></svg>`;
    else if (c.parents.length > 1) svg += `<circle ${at} r="4" fill="${color(l)}"/>`;
    else
      svg +=
        `<use href="#${spriteId(c.author)}" x="${X(l) - 9}" y="${Y(i) - 9}" width="18" height="18"/>` +
        `<circle ${at} r="9" style="stroke:${color(l)}" class="av${isHead(c) ? " head" : ""}"/>`;
    // labelled commits get a line from their label column to the dot, under it
    if (labels(c).length) svg = `<path d="M0 ${Y(i) + 0.5}H${X(l)}" stroke="${color(l)}" class="link"/>` + svg;
  }
  // the view box keeps whole-graph coordinates, the svg clips the edges at the chunk ends
  return `<svg class="lanes" width="${laneW}" height="${(to - from) * ROW}" viewBox="0 ${from * ROW} ${laneW} ${(to - from) * ROW}">${svg}</svg>`;
}

// rows per chunk; the chunks within two of the view are drawn, a fast scroll fills one at a time
const CHUNK = 40;

function fillChunk(k: number) {
  const from = k * CHUNK, to = Math.min(shown.length, from + CHUNK);
  chunks[k].innerHTML = lanesSvg(from, to);
  chunks[k].append(...shown.slice(from, to).map((c, i) => graphRow(c, rowColors[from + i], laneX(laid.nodes[from + i]))));
}

/** Draw the chunks around the view, empty the others. */
function drawRows() {
  const gr = $("graph"), first = Math.floor(gr.scrollTop / ROW / CHUNK) - 2, last = Math.floor((gr.scrollTop + gr.clientHeight) / ROW / CHUNK) + 2;
  chunks.forEach((el, k) => {
    const near = k >= first && k <= last;
    if (near && !el.childElementCount) fillChunk(k);
    else if (!near && el.childElementCount) el.replaceChildren();
  });
}

/** Scroll the history to the row of `hash`, drawing its chunk first. */
function showRow(hash: string, block: ScrollLogicalPosition) {
  const i = shown.findIndex((c) => c.hash === hash);
  if (i < 0) return;
  if (!chunks[Math.floor(i / CHUNK)].childElementCount) fillChunk(Math.floor(i / CHUNK));
  document.querySelector(`.row[data-hash="${hash}"]`)?.scrollIntoView({ block });
  drawRows();
}

/** One label per name: a local branch and its remotes on the same commit share it. */
function labels(c: Commit): Label[] {
  const out = new Map<string, Label>();
  const get = (name: string, tag = false) => {
    const key = `${tag}:${name}`;
    if (!out.has(key)) out.set(key, { name, tag, head: false, local: false, remotes: [] });
    return out.get(key)!;
  };
  for (const ref of c.refs) {
    const r = ref.replace(/^HEAD -> /, "");
    if (r.startsWith("tag: refs/tags/")) {
      if (!hiddenSet.has(r.slice(5))) get(r.slice(15), true);
    }
    else if (hiddenSet.has(r)) continue;
    else if (r.startsWith("refs/heads/")) {
      const l = get(r.slice(11));
      l.local = true;
      l.head ||= r !== ref;
    } else if (r.startsWith("refs/remotes/") && !r.endsWith("/HEAD")) {
      const full = r.slice(13), slash = full.indexOf("/"), remote = full.slice(0, slash);
      // a remote ref of no configured remote, like the `repo` tool's m/<branch>, is no remote branch
      if (!hiddenSet.has(remote) && refs.remotes.includes(remote)) get(full.slice(slash + 1)).remotes.push(remote);
    }
  }
  return [...out.values()].sort((a, b) => +b.head - +a.head || +a.tag - +b.tag || +b.local - +a.local);
}

const ico = (d: string, title = "") => h("span", { className: "ico", title, innerHTML: svg(d) });

function chip(l: Label) {
  const el = h(
    "span",
    {
      className: `ref${l.head ? " is-head" : ""}${l.tag ? " tag" : ""}`,
      title: l.tag ? `${l.name} (tag)` : "Double-click to checkout",
      ondblclick: (e: MouseEvent) => (e.stopPropagation(), !l.tag && !l.head && checkoutBranch(labelRef(l), !l.local)),
      oncontextmenu: (e: MouseEvent) => (e.stopPropagation(), popup(e, l.tag ? tagMenu(l.name) : branchMenu(labelRef(l), !l.local))),
    },
    ...(l.head ? [ico(ICONS.check)] : []),
    h("span", { className: "ref-name", textContent: l.name }),
  );
  if (l.tag) el.append(ico(ICONS.tag));
  if (l.local) el.append(ico(ICONS.local, `${l.name} (local branch)`));
  if (l.remotes.length) el.append(ico(ICONS.remote, l.remotes.map((r) => `${r} -> ${l.name} (remote branch)`).join("\n")));
  const wt = l.local && worktreeOf(l.name);
  if (wt) el.append(ico(ICONS.worktree, `Checked out in the worktree ${wt.path}`));
  return el;
}

function graphRow(c: Commit, lane: string, nodeX: number) {
  const ls = labels(c), stash = stashOf(c.hash);
  const row = h(
    "div",
    {
      className: `row${c.hash === "WIP" ? (conflictCount() ? " wip conflict" : " wip") : ""}${isHead(c) ? " row-head" : ""}${selected.includes(c.hash) || stashView?.hash === c.hash ? " sel" : ""}${hits.includes(c.hash) ? " match" : ""}`,
      onclick: (e: MouseEvent) => (stash ? showStash(stash) : clickRow(e, c.hash)),
      oncontextmenu: (e: MouseEvent) => (stash ? popup(e, stashMenu(stash)) : c.hash !== "WIP" && commitMenu(e, c)),
    },
    h(
      "div",
      { className: `refs${ls.length ? " has" : ""}` },
      h("div", { className: "refs-in" }, ...ls.map(chip), ...(ls.length > 1 ? [h("span", { className: "more", textContent: `+${ls.length - 1}` })] : [])),
    ),
    c.hash === "WIP"
      ? h(
          "span",
          { className: "subject" },
          ...(!opInfo ? [c.subject, ...fileCounts(wipFiles())] : conflictCount() ? conflictLine() : [c.subject, " · ", ...opLine(), ...fileCounts(wipFiles())]),
        )
      : stash
      ? h("span", { className: "subject", title: stash.name }, c.subject)
      : h(
          "span",
          { className: "subject", title: `${c.author} · ${dateFmt.format(c.time * 1000)}` },
          c.subject,
          h("span", { className: "body", textContent: c.body.replace(/\s*\n+\s*/g, " | ") }),
        ),
  );
  row.dataset.hash = c.hash;
  row.style.setProperty("--lane", lane);
  row.style.setProperty("--node-x", `${nodeX}px`);
  return row;
}

/** Click selects one commit, Ctrl+click picks commits to compare, Shift+click a range. */
function clickRow(e: MouseEvent, hash: string) {
  stashView = null;
  const idx = (x: string) => commits.findIndex((c) => c.hash === x);
  if (hash !== "WIP" && e.shiftKey && idx(anchor) >= 0) {
    const [a, b] = [idx(anchor), idx(hash)].sort((x, y) => x - y);
    selected = commits.slice(a, b + 1).map((c) => c.hash);
    rangeSel = true;
  } else if (hash !== "WIP" && e.ctrlKey) {
    const s = selected.filter((x) => x !== "WIP");
    selected = s.includes(hash) ? s.filter((x) => x !== hash) : [...s, hash];
    if (!selected.length) selected = ["WIP"];
    anchor = hash;
    rangeSel = false;
  } else {
    selected = [hash];
    anchor = hash;
    rangeSel = false;
  }
  paintSelection();
  renderPanel();
}

function paintSelection() {
  document.querySelectorAll<HTMLElement>(".row").forEach((r) => r.classList.toggle("sel", selected.includes(r.dataset.hash!) || stashView?.hash === r.dataset.hash));
}

/** The ref a label stands for: its local branch, else its first remote's. */
const labelRef = (l: Label) => (l.local ? l.name : `${l.remotes[0]}/${l.name}`);

/** Check out `name`; a remote branch whose local one is elsewhere asks first: reset the local one to it, or take it as it is. */
function checkoutBranch(name: string, remote: boolean) {
  const local = remote ? name.slice(name.indexOf("/") + 1) : name;
  // git refuses a branch another worktree has: open that worktree instead
  const wt = !remote && worktreeOf(local);
  if (wt) return openWorktree(wt.path);
  // a worktree whose folder is gone still holds its branch until pruned
  const stale = !remote && refs.worktrees.find((w) => w.branch === local && w.prunable);
  if (stale)
    return ask(`${local} is held by the worktree ${basename(stale.path)}, whose folder is gone. Prune it and checkout ${local}?`, "Prune and checkout").then(
      async (ok) => ok && (await op("worktree-prune")) && op("checkout", local),
    );
  const mine = refs.refs.find((r) => r.name === `refs/heads/${local}`), theirs = refs.refs.find((r) => r.name === `refs/remotes/${name}`);
  if (!remote || !mine || !theirs || mine.hash === theirs.hash) return op("checkout", local);
  // "[ahead 1, behind 2]" against its upstream
  const track = mine.upstream === name && mine.track ? ` (${mine.track.slice(1, -1)})` : "";
  const drops = /ahead/.test(track) ? `, its commits that are not on ${name} leave the branch` : "";
  dialog(
    `Local ${local} is not at ${name}${track}. Reset it to ${name}${drops}?`,
    [],
    `Reset ${local} to ${name}`,
    () => op("checkout-reset", [local, name]),
    [[`Checkout ${local}`, () => op("checkout", local)]],
  );
}

/** Checkout, merge and rebase for branch `name` (a remote one as "remote/branch"). */
function refMenu(name: string, remote: boolean): MenuItem[] {
  const branch = st?.branch || "HEAD";
  // checking out a remote branch by its short name creates the tracking branch
  const local = remote ? name.slice(name.indexOf("/") + 1) : name;
  const items: MenuItem[] = [];
  if (remote || name !== st?.branch) items.push([`Checkout ${local}`, () => checkoutBranch(name, remote)]);
  if (name !== st?.branch)
    items.push([`Merge ${name} into ${branch}`, () => op("merge", name)], [`Rebase ${branch} onto ${name}`, () => op("rebase", name)]);
  return items;
}

function commitMenu(e: MouseEvent, c: Commit) {
  const branch = st?.branch || "HEAD", ls = labels(c).filter((l) => !l.tag);
  popup(e, [
    ...ls.flatMap((l) => refMenu(labelRef(l), !l.local)),
    null,
    [`Checkout ${short(c.hash)} (detached)`, () => op("checkout", c.hash)],
    [`Rebase ${branch} onto ${short(c.hash)}`, () => op("rebase", c.hash)],
    [`Cherry-pick ${short(c.hash)}`, () => op("cherry-pick", c.hash)],
    null,
    ...commitItems(c.hash),
    null,
    ...copyItems(c.hash, ls[0]?.name ?? "", ls[0] && !ls[0].local ? ls[0].remotes[0] : linkRemote()),
  ]);
}

/** Branch `name` (a remote one as "remote/branch"): the same menu in the sidebar and on graph labels. */
function branchMenu(name: string, remote: boolean): MenuItem[] {
  const ref = refs.refs.find((r) => r.name === (remote ? `refs/remotes/${name}` : `refs/heads/${name}`));
  const sha = ref?.hash ?? "", current = !remote && name === st?.branch;
  // where the branch lives on a remote: itself, or the local branch's upstream while that still exists
  const up = ref?.upstream ?? "";
  const onRemote = remote ? name : refs.refs.some((r) => r.name === `refs/remotes/${up}`) ? up : "";
  const slash = onRemote.indexOf("/"), rem = onRemote.slice(0, slash), remBranch = onRemote.slice(slash + 1);
  return [
    ...refMenu(name, remote),
    null,
    ...(current ? ([["Pull", pull], ["Push", push], null] as MenuItem[]) : []),
    ...commitItems(sha),
    ...(current ? ([["Edit commit message", rewordHead]] as MenuItem[]) : []),
    null,
    ...(remote ? [] : ([[`Rename ${name}…`, () => askName("New branch name", name, (n) => op("branch-rename", [name, n]))]] as MenuItem[])),
    ...(remote || current ? [] : ([[`Delete ${name}`, () => deleteBranch(name, onRemote)]] as MenuItem[])),
    // a local branch's upstream too: one menu for both
    ...(onRemote
      ? ([[`Delete ${remBranch} on ${rem}`, () => ask(`Delete branch ${remBranch} on ${rem}? This pushes the deletion.`, "Delete").then((ok) => ok && op("push-delete", [rem, remBranch]))]] as MenuItem[])
      : []),
    null,
    ...copyItems(sha, remote ? remBranch : name, rem || linkRemote(), remBranch),
  ];
}

/** `git branch -d`, or `-D` after saying what is lost when the branch is merged nowhere. */
async function deleteBranch(name: string, upstream: string) {
  const merged = await run<boolean>("is_merged", { branch: name }).catch(() => false);
  if (merged) return (await ask(`Delete branch ${name}?`, "Delete")) && op("delete-branch", name);
  // a squash-merged pull request leaves its branch unmerged here
  const into = upstream || st?.branch || "HEAD";
  if (await ask(`${name} is not merged into ${into}. Delete it with its unmerged commits?`, "Force delete")) op("force-delete-branch", name);
}

function tagMenu(name: string): MenuItem[] {
  return [
    [`Checkout ${name} (detached)`, () => op("checkout", name)],
    null,
    ...refs.remotes.map((r): MenuItem => [`Push ${name} to ${r}`, () => op("tag-push", [r, name])]),
    [`Delete ${name}`, () => ask(`Delete tag ${name}?`, "Delete").then((ok) => ok && op("tag-delete", name))],
    ...refs.remotes.map(
      (r): MenuItem => [
        `Delete ${name} on ${r}`,
        () => ask(`Delete tag ${name} on ${r}? This pushes the deletion.`, "Delete").then((ok) => ok && op("push-delete", [r, `refs/tags/${name}`])),
      ],
    ),
    null,
    hideItem(`refs/tags/${name}`),
    ["Copy tag name", () => copy(name)],
  ];
}

/** What to do with commit `sha`, shared by the commit and branch menus. */
function commitItems(sha: string): MenuItem[] {
  const b = st?.branch || "HEAD";
  const reset: MenuItem[] = [
    ["Soft: keep the changes staged", () => op("reset-soft", sha)],
    ["Mixed: keep the changes unstaged", () => op("reset-mixed", sha)],
    ["Hard: discard every change", () => ask(`Reset ${b} to ${short(sha)} and discard every uncommitted change?`, "Reset").then((ok) => ok && op("reset-hard", sha))],
  ];
  return [
    ["Create branch here…", () => askName("New branch name", "", (n) => op("branch-create", [n, sha]))],
    [`Reset ${b} to this commit`, reset],
    [`Revert ${short(sha)}`, () => op("revert", sha)],
    ["Create tag here…", () => askName("Tag name", "", (n) => op("tag-create", [n, sha]))],
  ];
}

function copyItems(sha: string, branch: string, remote: string, remoteBranch = branch): MenuItem[] {
  return [
    ...(branch ? ([["Copy branch name", () => copy(branch)]] as MenuItem[]) : []),
    ["Copy commit SHA", () => copy(sha)],
    ...(remote && remoteBranch ? ([[`Copy link to branch on ${remote}`, async () => copy(`${await webUrl(remote)}/tree/${remoteBranch}`)]] as MenuItem[]) : []),
    ...(remote ? ([[`Copy link to commit on ${remote}`, async () => copy(`${await webUrl(remote)}/commit/${sha}`)]] as MenuItem[]) : []),
  ];
}

/** Files in the panels: stage/discard for WIP, restore for a commit, and opening them. */
function fileMenu(f: Change, kind: Kind, c?: Commit): MenuItem[] {
  const neutral = (e: unknown) => say(String(e));
  return [
    ...(kind === "unstaged" && isConflict(f)
      ? ([
          [`Take current (${opInfo?.current ?? "HEAD"})`, () => op("take-current", f.path)],
          [`Take incoming (${opInfo?.incoming ?? "theirs"})`, () => op("take-incoming", f.path)],
          ["Mark resolved", () => op("stage", f.path)],
        ] as MenuItem[])
      : kind === "unstaged"
      ? ([
          ["Stage", () => op("stage", f.path)],
          ["Discard changes", () => ask(`Discard all changes to ${f.path}?`, "Discard").then((ok) => (ok ? discard(f.path, f.code === "?") : undefined))],
        ] as MenuItem[])
      : []),
    ...(kind === "staged" ? ([["Unstage", () => op("unstage", f.path)]] as MenuItem[]) : []),
    null,
    ["File history", () => openHistory(f.path, c)],
    ["Open in VS Code", () => run("open_in_editor", { path: f.path, line: 1 }).catch(neutral)],
    ["Open in default program", () => run("open_default", { path: f.path, folder: false }).catch(neutral)],
    ["Show in folder", () => run("open_default", { path: f.path, folder: true }).catch(neutral)],
    ["Copy file path", () => copy(`${repo}/${f.path}`)],
    null,
    ...(c
      ? ([
          [
            `Restore file from ${short(c.hash)}`,
            () => ask(`Overwrite ${f.path} in the working tree with its version at ${short(c.hash)}?`, "Overwrite").then((ok) => ok && op("restore-file", [c.hash, f.path])),
          ],
        ] as MenuItem[])
      : []),
    [
      "Delete file",
      () => ask(`Delete ${f.path} from the working tree?`, "Delete").then((ok) => (ok ? run("delete_file", { path: f.path }).then(refresh, (e) => say(String(e), true)) : undefined)),
    ],
  ];
}

/** Select HEAD and open its message editor. */
async function rewordHead() {
  jumpTo(headHash());
  await renderPanel();
  $("c-msg").querySelector<HTMLElement>(".edit")?.click();
}

function popup(e: MouseEvent, items: MenuItem[]) {
  e.preventDefault();
  if (items.some(Boolean)) showMenu(items, e.clientX, e.clientY);
}

function showMenu(items: MenuItem[], x: number, y: number) {
  const m = $("menu");
  fillMenu(m, items);
  $("submenu").hidden = true;
  m.hidden = false;
  m.style.left = `${Math.min(x, innerWidth - m.offsetWidth - 4)}px`;
  m.style.top = `${Math.max(4, Math.min(y, innerHeight - m.offsetHeight - 4))}px`;
}

/** The rows of a menu; an entry with items shows them beside it on hover. */
function fillMenu(m: HTMLElement, items: MenuItem[]) {
  // separators only between two groups
  const kept = items.filter((it, i) => it || (items.slice(0, i).some(Boolean) && items.slice(i + 1).some(Boolean)));
  const rows = kept.filter((it, i) => it || kept[i - 1]);
  const sub = $("submenu");
  m.replaceChildren(
    ...rows.map((it) => {
      if (!it) return h("hr");
      const [label, act] = it;
      const b = h("button", { textContent: label });
      if (typeof act === "function") {
        b.onclick = act;
        // leaving for another row of the main menu closes the side one
        if (m !== sub) b.onmouseenter = () => void (sub.hidden = true);
        return b;
      }
      b.className = "sub";
      // a click keeps the menu open: the items are what matters
      b.onclick = (e) => e.stopPropagation();
      b.onmouseenter = () => {
        fillMenu(sub, act);
        sub.hidden = false;
        const r = b.getBoundingClientRect();
        sub.style.left = `${r.right + sub.offsetWidth + 4 > innerWidth ? r.left - sub.offsetWidth - 2 : r.right + 2}px`;
        sub.style.top = `${Math.max(4, Math.min(r.top - 6, innerHeight - sub.offsetHeight - 4))}px`;
      };
      return b;
    }),
  );
}

/** A one-field prompt where the menu was; Enter hands the trimmed text to `done`. */
function askName(label: string, initial: string, done: (name: string) => unknown) {
  setTimeout(() => {
    const box = h("input", { className: "ask", value: initial, placeholder: label, spellcheck: false, onclick: (e: Event) => e.stopPropagation() });
    box.onkeydown = (e) => {
      if (e.key === "Enter" && box.value.trim()) {
        $("menu").hidden = true;
        done(box.value.trim());
      }
    };
    const m = $("menu");
    m.replaceChildren(h("small", { textContent: label }), box);
    m.hidden = false;
    box.select();
  });
}

/* side panel */

const CLS: Record<string, string> = { M: "m", T: "m", A: "a", "?": "a", D: "d", R: "r", C: "r", U: "u" };
const STATUS_ORDER = "U?AMTRCD";

function fileList(
  el: HTMLElement,
  files: Change[],
  open: (f: Change) => void,
  actions: [string, (f: Change) => void, ((f: Change) => boolean)?][],
  menu: (f: Change) => MenuItem[],
) {
  if (fileQuery) files = files.filter((f) => f.path.toLowerCase().includes(fileQuery));
  const sort = store("files-sort") ?? "", dir = sort === "desc" ? -1 : 1;
  if (sort === "desc") files = [...files].sort((a, b) => b.path.localeCompare(a.path));
  if (sort === "status")
    files = [...files].sort((a, b) => STATUS_ORDER.indexOf(a.code) - STATUS_ORDER.indexOf(b.code) || a.path.localeCompare(b.path));
  const fileRow = (f: Change, dir: string, depth: number) => {
    const slash = f.path.lastIndexOf("/") + 1;
    const code = CLS[f.code];
    const row = h(
      "div",
      {
        className: `file${f.code ? "" : " same"}`,
        onclick: () => open(f),
        oncontextmenu: (e: MouseEvent) => popup(e, menu(f)),
        title: f.old ? `${f.old} → ${f.path}` : f.path,
      },
      h("span", { className: `code c-${code}`, innerHTML: code ? svg(ICONS[code]) : "", title: f.code }),
      h("span", { className: "path" }, h("span", { className: "dir", textContent: dir }), h("span", { className: "name", textContent: f.path.slice(slash) })),
      ...actions.filter(([, , when]) => !when || when(f)).map(([label, fn]) => h("button", { textContent: label, onclick: (e: Event) => (e.stopPropagation(), fn(f)) })),
    );
    row.dataset.path = f.path;
    row.style.paddingLeft = `${10 + depth * 20}px`;
    row.style.setProperty("--depth", String(depth));
    return row;
  };
  const tree = () => {
    const root: Dir = { dirs: new Map(), files: [] };
    for (const f of files) {
      let d = root;
      for (const part of f.path.split("/").slice(0, -1)) {
        if (!d.dirs.has(part)) d.dirs.set(part, { dirs: new Map(), files: [] });
        d = d.dirs.get(part)!;
      }
      d.files.push(f);
    }
    const rows: HTMLElement[] = [];
    order.length = 0;
    // folded folders are still walked: their files keep their place in `order`
    const walkDir = (d: Dir, prefix: string, depth: number, shown: boolean, route: string[]) => {
      for (let [name, sub] of [...d.dirs].sort(([a], [b]) => dir * a.localeCompare(b))) {
        // a chain of single-folder folders takes one row
        while (sub.dirs.size === 1 && !sub.files.length) {
          const [[n, s]] = sub.dirs;
          name += `/${n}`;
          sub = s;
        }
        const path = prefix + name, shut = treeOpen === flipped.has(path);
        if (shown) {
          const toggle = () => (flipped.has(path) ? flipped.delete(path) : flipped.add(path), draw());
          const folder = h("div", { className: "folder", onclick: toggle, title: path }, h("span", { className: "twisty", textContent: shut ? "▸" : "▾" }), ico(shut ? ICONS.folder : ICONS.folderOpen), name);
          if (shut) folder.append(...fileCounts(within(sub)));
          folder.style.paddingLeft = `${8 + depth * 20}px`;
          folder.style.setProperty("--depth", String(depth));
          rows.push(folder);
        }
        walkDir(sub, `${path}/`, depth + 1, shown && !shut, [...route, path]);
      }
      for (const f of d.files) {
        order.push(f);
        routes.set(f.path, route);
        if (shown) rows.push(fileRow(f, "", depth));
      }
    };
    walkDir(root, "", 0, true, []);
    return rows;
  };
  const order: Change[] = [];
  const routes = new Map<string, string[]>();
  const draw = () => {
    const isTree = store("files-view") === "tree";
    el.replaceChildren(...(isTree ? tree() : files.map((f) => fileRow(f, f.path.slice(0, f.path.lastIndexOf("/") + 1), 0))));
    if (!isTree) order.splice(0, order.length, ...files);
    markOpenFile();
  };
  const reveal = (path: string) => {
    const shut = (routes.get(path) ?? []).filter((p) => treeOpen === flipped.has(p));
    if (!shut.length) return;
    shut.forEach((p) => (treeOpen ? flipped.delete(p) : flipped.add(p)));
    draw();
  };
  fileLists.set(el, { order, reveal });
  draw();
}

const within = (d: Dir): Change[] => [...d.files, ...[...d.dirs.values()].flatMap(within)];

/** Every changed file once, staged or not. */
const wipFiles = () => [...new Map([...(st?.staged ?? []), ...(st?.unstaged ?? [])].map((f) => [f.path, f])).values()];

/** Per-kind counts with their icons, like "✎ 3 + 1". */
function fileCounts(files: Change[]) {
  return ["m", "a", "d", "r", "u"].flatMap((cls) => {
    const n = files.filter((f) => CLS[f.code] === cls).length;
    return n ? [h("span", { className: `count c-${cls}`, innerHTML: `${svg(ICONS[cls])}${n}` })] : [];
  });
}

function paintFileOpts() {
  const view = store("files-view") || "path";
  document.querySelectorAll<HTMLElement>("[data-files]").forEach((b) => b.classList.toggle("on", b.dataset.files === view));
  document.querySelectorAll<HTMLElement>(".tree-all").forEach((b) => {
    const what = b.dataset.open ? "Expand all folders" : "Collapse all folders";
    b.classList.toggle("off", view !== "tree");
    b.title = view === "tree" ? what : `${what}: only in Tree view`;
  });
  document.querySelectorAll<HTMLElement>(".files-opts .sort").forEach((b) => (b.textContent = SORTS[store("files-sort") ?? ""] ?? "A–Z"));
}

/** What the commit panel shows: one commit, a stash, a compare or a range as one pseudo commit. */
function panelCommit(): { c: Commit; message?: string; head: (Node | string)[]; author?: Commit } | null {
  if (stashView) {
    const s = stashView;
    const c = { hash: s.hash, parents: s.parents.slice(0, 1), author: "", time: 0, refs: [], subject: s.subject, body: "" };
    return { c, message: `${s.name}\n${s.subject}`, head: ["stash ", sha(s.hash), " · on ", sha(s.parents[0] ?? "")] };
  }
  const sel = commits.filter((c) => selected.includes(c.hash));
  if (!sel.length) return null;
  const newest = sel[0], oldest = sel[sel.length - 1];
  if (sel.length === 1) {
    const parents = newest.parents.flatMap((p, i) => (i ? [" + ", sha(p)] : [" · parent ", sha(p)]));
    return { c: newest, head: ["commit ", sha(newest.hash), ...parents], author: newest };
  }
  // a range diffs from before its oldest commit, a Ctrl pick compares the two ends
  const base = rangeSel ? (oldest.parents[0] ?? "") : oldest.hash;
  const list = sel.map((c) => `${short(c.hash)}  ${c.subject}`).join("\n");
  return {
    c: { ...newest, parents: base ? [base] : [] },
    message: rangeSel ? `${sel.length} commits\n${list}` : `Compare ${short(oldest.hash)} → ${short(newest.hash)}\n${list}`,
    head: [rangeSel ? "range " : "compare ", base ? sha(base) : "root", "..", sha(newest.hash)],
  };
}

/** A short hash that copies the full one on click. */
const sha = (hash: string) => h("span", { className: "sha", textContent: short(hash), title: `Copy ${hash}`, onclick: () => copy(hash) });

// where the last click landed: "Copied!" pops up there
let clickAt = [0, 0];
addEventListener("pointerdown", (e) => (clickAt = [e.clientX, e.clientY]), true);

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    say(`copied ${text.length > 60 ? `${text.slice(0, 60)}…` : text}`);
    const tip = h("div", { className: "copied", textContent: "Copied!" });
    Object.assign(tip.style, { left: `${clickAt[0]}px`, top: `${clickAt[1] - 30}px` });
    document.body.append(tip);
    setTimeout(() => tip.remove(), 1200);
  } catch (e) {
    say(String(e), true);
  }
}

const avatar = (name: string) => h("span", { className: "avatar", title: name, innerHTML: avatarSvg(name) });

function authorBlock(c: Commit) {
  return [avatar(c.author), h("div", {}, c.author, h("small", { textContent: `authored ${dateFmt.format(c.time * 1000)}` }))];
}

function fileStats(files: Change[]) {
  const kinds: [string, string, string][] = [["MT", "modified", "m"], ["A", "added", "a"], ["D", "deleted", "d"], ["RC", "renamed", "r"]];
  return kinds.flatMap(([codes, label, cls]) => {
    const n = files.filter((f) => codes.includes(f.code)).length;
    return n ? [h("span", { className: `c-${cls}`, innerHTML: `${svg(ICONS[cls])} ${n} ${label}` })] : [];
  });
}

/** Swap the HEAD commit's message for an editor that rewrites it in place. */
function editMessage(c: Commit, msg: string) {
  if (!isHead(c)) return say("only the checked out commit can be reworded", true);
  editing = c.hash;
  $("c-msg").ondblclick = null;
  const [s, d] = splitMsg(msg);
  const summary = h("input", { className: "msg-in", value: s, spellcheck: false });
  const desc = h("textarea", { className: "msg-in", value: d, spellcheck: false, placeholder: "Description" });
  const left = h("small");
  const cancel = () => ((editing = ""), renderPanel());
  const update = async () => {
    const m = joinMsg(summary.value, desc.value);
    if (!m) return say("empty commit message", true);
    if (await op("reword", m)) jumpTo(headHash());
  };
  summary.oninput = () => countLeft(summary, left);
  countLeft(summary, left);
  for (const el of [summary, desc]) {
    el.onkeydown = (e) => {
      // a handler returning false cancels the key, so no expression body here
      if (e.ctrlKey && e.key === "Enter") update();
    };
  }
  $("c-msg").classList.add("editing");
  $("c-msg").replaceChildren(
    h("div", { className: "summary" }, summary, left),
    desc,
    h("div", { className: "edit-btns" }, h("button", { className: "good", textContent: "Update Message", onclick: update }), h("button", { className: "bad", textContent: "Cancel Amend", onclick: cancel })),
  );
  summary.focus();
}

async function renderPanel() {
  const n = ++panelSeq;
  const wip = !stashView && selected[0] === "WIP";
  $("wip").hidden = !wip;
  $("commit").hidden = wip;
  if (wip) {
    if (!st) return;
    const n = new Set([...st.unstaged, ...st.staged].map((f) => f.path)).size;
    const conflicts = st.unstaged.filter(isConflict), clean = (f: Change) => !isConflict(f);
    $("wip-title").replaceChildren(...(opInfo ? [opTitle(conflicts.length)] : [`${n} file change${n === 1 ? "" : "s"} on `, h("b", { textContent: st.branch || "detached HEAD" })]));
    $("unstaged-label").textContent = conflicts.length ? "Conflicted Files" : "Unstaged Files";
    $("staged-label").textContent = opInfo ? "Resolved Files" : "Staged Files";
    $("stage-all").textContent = conflicts.length ? "Mark all resolved" : "Stage all changes";
    $("unstaged-n").textContent = `(${st.unstaged.length})`;
    $("staged-n").textContent = `(${st.staged.length})`;
    renderCommitBtn();
    fileList($("unstaged"), [...conflicts, ...st.unstaged.filter(clean)], (f) => openDiff("unstaged", f), [
      ["Mark resolved", (f) => op("stage", f.path), isConflict],
      ["Discard", (f) => ask(`Discard all changes to ${f.path}?`, "Discard").then((ok) => (ok ? discard(f.path, f.code === "?") : undefined)), clean],
      ["Stage", (f) => op("stage", f.path), clean],
    ], (f) => fileMenu(f, "unstaged"));
    fileList($("staged"), st.staged, (f) => openDiff("staged", f), [["Unstage", (f) => op("unstage", f.path)]], (f) => fileMenu(f, "staged"));
    return markOpenFile();
  }
  const view = panelCommit();
  if (!view) return;
  try {
    const info = await run<{ message: string; files: Change[] }>("commit_info", { hash: view.c.hash, parent: view.c.parents[0] ?? "" });
    if (n !== panelSeq) return;
    const all = $("all-files").classList.contains("on") ? await run<string[]>("files", { at: view.c.hash }) : [];
    if (n !== panelSeq) return;
    const msg = view.message ?? info.message;
    $("c-head").replaceChildren(...view.head);
    if (editing !== view.c.hash) {
      editing = "";
      const [summary, desc] = splitMsg(msg);
      const reword = view.author && isHead(view.c) ? () => editMessage(view.c, msg) : null;
      $("c-msg").classList.remove("editing");
      $("c-msg").replaceChildren(
        h("div", { id: "c-summary", textContent: summary }),
        h("div", { id: "c-desc", textContent: desc }),
        ...(reword ? [h("button", { className: "edit", textContent: "Edit", title: "Reword (double-click)", onclick: reword })] : []),
      );
      $("c-msg").ondblclick = reword;
    }
    $("c-author").replaceChildren(...(view.author ? authorBlock(view.author) : []));
    $("c-stats").replaceChildren(...fileStats(info.files));
    // all files: the commit's tree, with the changed ones marked
    const changed = new Map(info.files.map((f) => [f.path, f]));
    const files = all.length ? [...new Set([...all, ...changed.keys()])].sort().map((p) => changed.get(p) ?? { path: p, old: null, code: "" }) : info.files;
    fileList($("c-files"), files, (f) => openDiff("commit", f, view.c), [], (f) => fileMenu(f, "commit", view.c));
  } catch (e) {
    say(String(e), true);
  }
  markOpenFile();
}

/** The file open in the diff or the merge tool. */
const openFile = () => cur ?? (merging ? { kind: "unstaged" as Kind, f: merging.f } : null);

function markOpenFile() {
  document.querySelectorAll(".file.sel").forEach((r) => r.classList.remove("sel"));
  const open = openFile();
  if (!open) return;
  const list = open.kind === "commit" ? "c-files" : open.kind;
  $(list).querySelector(`.file[data-path="${CSS.escape(open.f.path)}"]`)?.classList.add("sel");
}

const isConflict = (f: Change) => f.code === "U";
// a rebase or cherry-pick step whose changes are all already there
const emptyStep = () => !!opInfo && opInfo.state !== "merge" && !st?.staged.length && !st?.unstaged.length;
const conflictCount = () => st?.unstaged.filter(isConflict).length ?? 0;

/** "Rebasing feature onto main" for the operation in progress. */
function opLine(): (Node | string)[] {
  const o = opInfo!, verb = { rebase: "Rebasing", merge: "Merging", "cherry-pick": "Cherry-picking", revert: "Reverting" }[o.state] ?? o.state;
  return [`${verb} `, h("b", { textContent: o.incoming }), ` ${o.state === "merge" ? "into" : "onto"} `, h("b", { textContent: o.current })];
}

function opTitle(conflicts: number) {
  const o = opInfo!, what = o.state[0].toUpperCase() + o.state.slice(1);
  return h(
    "span",
    { className: "op-head" },
    h("span", { className: conflicts ? "op-bad" : "", textContent: conflicts ? `${what} conflicts detected` : `${what} in progress` }),
    h("span", {}, ...opLine(), ...(o.step ? [` · commit ${o.step.replace("/", " of ")}`] : [])),
  );
}

/** The WIP row while files are in conflict: an orange bar. */
function conflictLine(): (Node | string)[] {
  const k = conflictCount();
  return [ico(ICONS.error), `${k} file conflict${k === 1 ? "" : "s"} · `, ...opLine()];
}

const amending = () => $("amend").classList.contains("on");

function renderCommitBtn() {
  const amend = amending(), staged = st?.staged.length ?? 0;
  const b = $("commit-btn") as HTMLButtonElement;
  countLeft(input("summary"), $("summary-n"));
  // an operation in progress commits through its Continue
  b.hidden = $("amend").hidden = !!opInfo;
  $("op-btns").hidden = !opInfo;
  if (opInfo) {
    const left = conflictCount(), c = $("op-continue");
    c.textContent = opInfo.state === "merge" ? "Commit and merge" : `Continue ${opInfo.state}`;
    // a class, not `disabled`: WebKit shows no tooltip on a disabled button
    c.classList.toggle("off", left > 0);
    c.title = left ? `Resolve the ${left} conflicted file${left === 1 ? "" : "s"} first` : emptyStep() ? "Nothing left to commit in this step: Continue skips it" : "";
    $("op-skip").hidden = opInfo.state === "merge";
    $("op-abort").textContent = `Abort ${opInfo.state}`;
  }
  b.disabled = !input("summary").value.trim() || (!staged && !amend);
  b.textContent = amend
    ? "Amend previous commit"
    : !staged
      ? "Stage files to commit"
      : b.disabled
        ? "Type a summary to commit"
        : `Commit changes to ${staged} file${staged === 1 ? "" : "s"}`;
}

async function commit() {
  const amend = amending();
  if (($("commit-btn") as HTMLButtonElement).disabled) return;
  if (await op(amend ? "amend" : "commit", getMsg())) {
    $("amend").classList.remove("on");
    setMsg("");
  }
}

/* diff */

function editor() {
  if (diffEditor) return diffEditor;
  monaco.editor.defineTheme("krill", {
    base: "vs-dark",
    inherit: true,
    // VS Code's Dark Modern syntax colors
    rules: [
      { token: "comment", foreground: "6a9955" },
      { token: "keyword", foreground: "569cd6" },
      { token: "keyword.directive", foreground: "c586c0" },
      ...["if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "return", "goto"].map((k) => ({ token: `keyword.${k}`, foreground: "c586c0" })),
      { token: "string", foreground: "ce9178" },
      { token: "string.escape", foreground: "d7ba7d" },
      { token: "number", foreground: "b5cea8" },
      { token: "type", foreground: "4ec9b0" },
      { token: "identifier", foreground: "9cdcfe" },
      { token: "identifier.function", foreground: "dcdcaa" },
      { token: "identifier.macro", foreground: "569cd6" },
      { token: "regexp", foreground: "d16969" },
      { token: "delimiter", foreground: "cccccc" },
    ],
    colors: {
      "editor.foreground": "#cccccc",
      "editor.background": "#1b1f27",
      "editorGutter.background": "#1b1f27",
      "editorLineNumber.foreground": "#5d6575",
      "editorLineNumber.activeForeground": "#e4e8ef",
      "editor.lineHighlightBackground": "#222833",
      "editor.selectionBackground": "#1a9ea666",
      "editorWidget.background": "#232832",
      "scrollbarSlider.background": "#ffffff14",
      "diffEditor.insertedLineBackground": "#3ee88f14",
      "diffEditor.insertedTextBackground": "#3ee88f38",
      "diffEditor.removedLineBackground": "#ff547014",
      "diffEditor.removedTextBackground": "#ff547038",
      "diffEditor.diagonalFill": "#ffffff0c",
      "diffEditorGutter.insertedLineBackground": "#3ee88f30",
      "diffEditorGutter.removedLineBackground": "#ff547030",
    },
  });

  diffEditor = monaco.editor.createDiffEditor($("editor"), {
    theme: "krill",
    automaticLayout: true,
    fontFamily: getComputedStyle(document.body).getPropertyValue("--mono"),
    fontSize: 13,
    stickyScroll: { enabled: false },
    scrollBeyondLastLine: false,
    // its height lands ~200 ms late, once long lines are measured, and rescales the change markers; Shift+wheel still scrolls sideways
    scrollbar: { horizontal: "hidden" },
    // whitespace-only changes must show: they get staged too
    ignoreTrimWhitespace: false,
    originalEditable: false,
    renderMarginRevertIcon: false,
    renderGutterMenu: false,
    useInlineViewWhenSpaceIsLimited: false,
    // ours instead: line actions, no command palette
    contextmenu: false,
  });
  const me = diffEditor.getModifiedEditor();
  lineActions(me, false);
  lineActions(diffEditor.getOriginalEditor(), true);
  me.onDidFocusEditorText(() => (lastSide = "mod"));
  diffEditor.getOriginalEditor().onDidFocusEditorText(() => (lastSide = "orig"));
  diffEditor.onDidUpdateDiff(updateHunkBars);
  me.onDidLayoutChange(updateHunkBars);
  // the text layer covers view zones and Monaco hit-tests itself: match the mouse to a bar button by position
  const barButton = (e: Monaco.editor.IEditorMouseEvent) => {
    if (e.target.type !== monaco.editor.MouseTargetType.CONTENT_VIEW_ZONE) return undefined;
    const node = bars.nodes[bars.mod.indexOf(e.target.detail.viewZoneId)];
    const { clientX: x, clientY: y } = e.event.browserEvent;
    return [...(node?.querySelectorAll("button") ?? [])].find((b) => {
      const r = b.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
  };
  let hovered: HTMLElement | undefined;
  const hoverButton = (b?: HTMLElement) => {
    hovered?.classList.remove("hover");
    (hovered = b)?.classList.add("hover");
    me.getDomNode()!.classList.toggle("on-button", !!b);
  };
  me.onMouseMove((e) => hoverButton(barButton(e)));
  me.onMouseLeave(() => hoverButton());
  me.onMouseDown((e) => barButton(e)?.click());
  me.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save().then(refresh));
  setMode((store("mode") as Mode) || "hunk");
  return diffEditor;
}

/** The line-level actions of one side: a +/− on the hovered changed line and the right-click menu. */
function lineActions(ed: Monaco.editor.ICodeEditor, orig: boolean) {
  const hover = ed.createDecorationsCollection();
  const staging = () => !!cur && cur.kind !== "commit";
  const changed = (l: number) => hunks.some((c) => (orig ? c.oe && l >= c.os && l <= c.oe : c.me && l >= c.ms && l <= c.me));
  const act = () => (cur?.kind === "staged" ? "unstage" : "stage");
  ed.onMouseMove((e) => {
    // a view zone reports the line next to it
    const zone = [monaco.editor.MouseTargetType.CONTENT_VIEW_ZONE, monaco.editor.MouseTargetType.GUTTER_VIEW_ZONE].includes(e.target.type);
    const l = zone ? 0 : (e.target.position?.lineNumber ?? 0);
    const on = staging() && changed(l);
    const cls = `line-act ${act()}`;
    hover.set(on ? [{ range: new monaco.Range(l, 1, l, 1), options: { glyphMarginClassName: cls, glyphMarginHoverMessage: { value: `${act() === "stage" ? "Stage" : "Unstage"} this line` } } }] : []);
  });
  ed.onMouseLeave(() => hover.clear());
  ed.onMouseDown((e) => {
    const l = e.target.position?.lineNumber ?? 0;
    // the + spills from the glyph margin into the line decorations column
    const gutter = [monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN, monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS];
    if (!gutter.includes(e.target.type) || !staging() || !changed(l)) return;
    const one = new Set([l]), none = new Set<number>();
    applyLines(orig ? { removed: one, added: none } : { removed: none, added: one }, act());
  });
  if (!orig) removedLineActions(ed, staging, act);
  ed.onContextMenu((e) => {
    lastSide = orig ? "orig" : "mod";
    const sel = ed.getSelection(), model = ed.getModel();
    const text = sel && model ? (sel.isEmpty() ? model.getLineContent(sel.startLineNumber) : model.getValueInRange(sel)) : "";
    const lines = (action: "stage" | "unstage" | "discard") => () => applyLines(selection(), action);
    popup(e.event.browserEvent, [
      ...(cur?.kind === "unstaged" && staging()
        ? ([["Discard selected lines", lines("discard")], ["Stage selected lines", lines("stage")]] as MenuItem[])
        : []),
      ...(cur?.kind === "staged" ? ([["Unstage selected lines", lines("unstage")]] as MenuItem[]) : []),
      null,
      ["Copy", () => copy(text)],
    ]);
  });
}

/** The +/− of each removed line in inline view, where Monaco draws them in a view zone, not as editor lines. */
function removedLineActions(ed: Monaco.editor.ICodeEditor, staging: () => boolean, act: () => "stage" | "unstage") {
  const mark = h("div", {});
  const lh = () => ed.getOption(monaco.editor.EditorOption.lineHeight);
  // ours, not Monaco's deleted-lines menu
  mark.addEventListener("mousedown", (ev) => ev.stopPropagation());
  mark.addEventListener("pointerdown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    mark.remove();
    applyLines({ removed: new Set([Number(mark.dataset.line)]), added: new Set() }, act());
  });
  ed.onMouseMove((e) => {
    const t = e.target;
    const zone = t.type === monaco.editor.MouseTargetType.CONTENT_VIEW_ZONE || t.type === monaco.editor.MouseTargetType.GUTTER_VIEW_ZONE ? t.detail : undefined;
    const margin = zone && ed.getDomNode()!.querySelector<HTMLElement>(`.inline-deleted-margin-view-zone[monaco-view-zone="${zone.viewZoneId}"]`);
    // a deletion at the top of the file follows line 0
    const after = zone?.positionBefore ? zone.afterLineNumber : 0;
    const c = hunks.find((c) => c.oe && (c.me ? c.ms - 1 : c.ms) === after);
    const i = margin ? Math.floor((e.event.browserEvent.clientY - margin.getBoundingClientRect().top) / lh()) : -1;
    if (!margin || !c || !staging() || i < 0 || c.os + i > c.oe) return mark.remove();
    const lay = ed.getLayoutInfo();
    mark.className = `line-act ${act()}`;
    mark.title = `${act() === "stage" ? "Stage" : "Unstage"} this line`;
    mark.dataset.line = String(c.os + i);
    Object.assign(mark.style, { position: "absolute", top: `${i * lh()}px`, left: `${lay.glyphMarginLeft}px`, width: `${lay.glyphMarginWidth}px`, height: `${lh()}px` });
    margin.append(mark);
  });
  ed.onMouseLeave(() => mark.remove());
}

function setOptions(o: Monaco.editor.IDiffEditorOptions) {
  editor().updateOptions(o);
  // the diff editor forces its sub-editors' minimap off on every update; hunk view hides too much for one
  const minimap = { enabled: store("mode") !== "hunk", renderCharacters: false, showSlider: "always" as const };
  editor().getModifiedEditor().updateOptions({ minimap });
}

function setMode(m: Mode) {
  store("mode", m);
  setOptions({ renderSideBySide: m === "split", hideUnchangedRegions: { enabled: m === "hunk" } });
  updateHunkBars();
  document.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
}

const lineChanges = (): C4[] =>
  (editor().getLineChanges() ?? []).map((c) => ({
    os: c.originalStartLineNumber,
    oe: c.originalEndLineNumber,
    ms: c.modifiedStartLineNumber,
    me: c.modifiedEndLineNumber,
  }));

/** A header bar above each hunk with its stage / unstage / discard buttons. */
/** Undo hunk `c` of the shown commit in the working tree, where it shows up unstaged for review. */
async function revertHunk(c: C4) {
  if (!cur?.c) return;
  const { f } = cur, at = cur.c;
  try {
    await run("revert_hunk", { commit: at.hash, parent: at.parents[0] ?? "", path: f.path, line: c.ms });
    toast(`Reverted a hunk of ${basename(f.path)}`, `From ${short(at.hash)}: the change is in the working tree, unstaged.`, "info");
  } catch (e) {
    say(String(e), true);
  }
  refresh();
}

function updateHunkBars() {
  const ed = editor(), split = store("mode") === "split";
  const acts: [string, string][] =
    !cur ? []
    : cur.kind === "unstaged" ? [["discard", "Discard hunk"], ["stage", "Stage hunk"]]
    : cur.kind === "staged" ? [["unstage", "Unstage hunk"]]
    : cur.c?.hash !== "WORKTREE" ? [["revert", "Revert hunk"]]
    : [];
  hunks = cur ? lineChanges() : [];
  const bar = (c: C4, buttons: boolean) => {
    const count = (s: number, e: number) => (e ? e - s + 1 : 0);
    const el = h("div", { className: "hunk-bar" }, h("span", { textContent: `@@ -${c.os},${count(c.os, c.oe)} +${c.ms},${count(c.ms, c.me)} @@` }));
    if (buttons)
      for (const [act, label] of acts) {
        el.append(h("button", { className: `hunk-${act}`, textContent: label, onclick: () => (act === "revert" ? revertHunk(c) : applyLines(allLines([c]), act as "stage" | "unstage" | "discard")) }));
      }
    // as wide as the visible text area, not the longest line, so the buttons stay in view
    const lay = ed.getModifiedEditor().getLayoutInfo();
    el.style.width = `${lay.contentWidth - lay.verticalScrollbarWidth}px`;
    // Monaco sets display on the zone node itself: the flex bar goes inside it
    return h("div", {}, el);
  };
  // a pure insertion or deletion sits after its anchor line, a change replaces lines from its start
  ed.getModifiedEditor().changeViewZones((z) => {
    bars.mod.forEach((id) => z.removeZone(id));
    bars.nodes = hunks.map((c) => bar(c, true));
    bars.mod = hunks.map((c, i) => z.addZone({ afterLineNumber: c.me ? c.ms - 1 : c.ms, heightInPx: 30, domNode: bars.nodes[i] }));
  });
  // the original side gets the same bars in split view, so both sides stay aligned
  ed.getOriginalEditor().changeViewZones((z) => {
    bars.orig.forEach((id) => z.removeZone(id));
    bars.orig = split ? hunks.map((c) => z.addZone({ afterLineNumber: c.oe ? c.os - 1 : c.os, heightInPx: 30, domNode: bar(c, false) })) : [];
  });
}

async function fetchSides(kind: Kind, f: Change, c?: Commit): Promise<[Blob, Blob]> {
  const none: Blob = { text: "", exists: false, binary: false };
  const blob = (at: string, path: string) => (at ? run<Blob>("blob", { at, path }) : Promise.resolve(none));
  const old = f.old ?? f.path;
  if (kind === "unstaged") return Promise.all([blob("INDEX", f.path), blob("WORKTREE", f.path)]);
  if (kind === "staged") return Promise.all([blob("HEAD", old), blob("INDEX", f.path)]);
  return Promise.all([blob(c!.parents[0] ?? "", old), blob(c!.hash, f.path)]);
}

async function openDiff(kind: Kind, f: Change, c?: Commit, inHistory = false) {
  await loadMonaco();
  // a file picked outside the history leaves it
  if (hist && !inHistory) await closeHistory();
  if (kind === "unstaged" && isConflict(f)) return openConflict(f);
  if (!(await closeMerge())) return;
  // clicking the open file again closes it
  if (cur && cur.kind === kind && cur.f.path === f.path && cur.c?.hash === c?.hash && cur.c?.parents[0] === c?.parents[0]) return closeDiff();
  if (cur?.dirty && !(await ask(`Drop unsaved edits to ${cur.f.path}?`, "Drop edits"))) return;
  let orig: Blob, mod: Blob;
  try {
    [orig, mod] = await fetchSides(kind, f, c);
  } catch (e) {
    return say(String(e), true);
  }
  cur = { kind, f, c, orig, mod, dirty: false };
  $("diff").hidden = false;
  document.body.classList.add("diffing");
  const range = c ? `  ·  ${c.parents[0] ? short(c.parents[0]) : "root"}..${short(c.hash)}` : "";
  $("d-path").textContent = (f.old ? `${f.old} → ${f.path}` : f.path) + range;
  paintOpenEditor();
  markOpenFile();
  // Monaco normalizes line endings, so a CRLF<->LF rewrite would not show at all
  const eol = (t: string) => (t.includes("\r\n") ? "CRLF" : t.includes("\n") ? "LF" : "");
  if (eol(orig.text) && eol(mod.text) && eol(orig.text) !== eol(mod.text))
    say(`${f.path}: line endings changed ${eol(orig.text)} → ${eol(mod.text)}, not shown in the diff`, true);
  const binary = orig.binary || mod.binary;
  $("editor").hidden = binary;
  $("binary").hidden = !binary;
  $("save").hidden = true;
  if (binary) return;
  // the folds land a moment after the text: the bare file would flash in between
  if (!inHistory) $("diff").classList.add("blank");
  setModels(false);
  diffDrawn().then(() => requestAnimationFrame(() => $("diff").classList.remove("blank")));
}

function paintOpenEditor() {
  if (!cur) return;
  const { f } = cur;
  // a file from another branch may not be on disk: say so on the button, not as an error
  const ed = $("open-editor");
  run<boolean>("in_worktree", { path: f.path }).then((ok) => {
    if (cur?.f.path !== f.path) return;
    // a class, not `disabled`: WebKit shows no tooltip on a disabled button
    ed.classList.toggle("off", !ok);
    ed.title = ok ? "Open the working tree file in VS Code" : `${f.path} is not in the working tree (not on the checked out branch)`;
  });
}

function setModels(keepView: boolean) {
  if (!cur) return;
  const ed = editor();
  const view = keepView ? ed.saveViewState() : null;
  const prev = ed.getModel();
  const uri = (side: string) => monaco.Uri.from({ scheme: "krill", path: `/${++seq}/${side}/${cur!.f.path}` });
  const modified = monaco.editor.createModel(cur.mod.text, undefined, uri("b"));
  ed.setModel({ original: monaco.editor.createModel(cur.orig.text, undefined, uri("a")), modified });
  prev?.original.dispose();
  prev?.modified.dispose();
  setOptions({ readOnly: !(cur.kind === "unstaged" && cur.mod.exists), glyphMargin: cur.kind !== "commit" });
  modified.onDidChangeContent(() => {
    if (!cur) return;
    cur.dirty = true;
    $("save").hidden = false;
  });
  if (view) ed.restoreViewState(view);
}

async function reloadDiff() {
  if (!cur || cur.dirty || !st) return;
  // the file may have moved between lists or changed status code
  if (cur.kind !== "commit") cur.f = st[cur.kind].find((x) => x.path === cur!.f.path) ?? cur.f;
  const [orig, mod] = await fetchSides(cur.kind, cur.f, cur.c);
  if (!cur || cur.dirty) return;
  paintOpenEditor();
  if (orig.text === cur.orig.text && mod.text === cur.mod.text && orig.binary === cur.orig.binary) return;
  Object.assign(cur, { orig, mod });
  if (!orig.binary && !mod.binary) setModels(true);
}

async function closeDiff(force = false) {
  if (!force && cur?.dirty && !(await ask(`Drop unsaved edits to ${cur.f.path}?`, "Drop edits"))) return;
  cur = null;
  $("diff").hidden = true;
  document.body.classList.remove("diffing");
  markOpenFile();
}

async function save() {
  if (!cur?.dirty) return;
  const text = editor().getModifiedEditor().getModel()!.getValue(monaco.editor.EndOfLinePreference.TextDefined, true);
  try {
    await run("write_file", { path: cur.f.path, text });
  } catch (e) {
    return say(String(e), true);
  }
  cur.mod.text = text;
  cur.dirty = false;
  $("save").hidden = true;
  say(`saved ${cur.f.path}`);
}

/** Changed lines under the selection of the side that had focus last. */
function selection(): Lines {
  const fromOrig = lastSide === "orig" && store("mode") === "split";
  const side = fromOrig ? editor().getOriginalEditor() : editor().getModifiedEditor();
  const sel = new Set<number>();
  for (const s of side.getSelections() ?? []) {
    // a drag ending at column 1 does not take that line
    const end = s.endLineNumber > s.startLineNumber && s.endColumn === 1 ? s.endLineNumber - 1 : s.endLineNumber;
    for (let l = s.startLineNumber; l <= end; l++) sel.add(l);
  }
  return pickLines(lineChanges(), sel, fromOrig);
}

async function applyLines(pick: Lines, action: "stage" | "unstage" | "discard") {
  if (!cur) return;
  if (!pick.removed.size && !pick.added.size) return say("no changed line under the cursor/selection", true);
  await save();
  const { f, orig, mod } = cur;
  const ch = lineChanges(), all = allLines(ch);
  const whole = pick.removed.size === all.removed.size && pick.added.size === all.added.size;
  const minus = (a: Set<number>, b: Set<number>) => new Set([...a].filter((x) => !b.has(x)));
  const keep = () => applyChanges(orig.text, mod.text, ch, minus(all.removed, pick.removed), minus(all.added, pick.added));
  if (action === "discard") return discard(f.path, f.code === "?", whole ? undefined : keep());
  if (whole) {
    await op(action, f.path);
    return;
  }
  try {
    if (action === "stage") await run("stage_text", { path: f.path, text: applyChanges(orig.text, mod.text, ch, pick.removed, pick.added) });
    if (action === "unstage") await run("stage_text", { path: f.path, text: keep() });
    say(`${action}d ${pick.removed.size + pick.added.size} line(s) of ${f.path}`);
  } catch (e) {
    say(String(e), true);
  }
  await refresh();
}

/** Discard `path` back to the index, or to `text` for some of its lines; undone by writing the old text back. */
async function discard(path: string, untracked: boolean, text?: string) {
  const t = tabs[active];
  const read = async () => {
    const b = await run<Blob>("blob", { at: "WORKTREE", path });
    return b.binary ? undefined : b.exists ? b.text : null;
  };
  const before = await read().catch(() => undefined);
  if (text === undefined) await op(untracked ? "clean" : "discard", path);
  else await run("write_file", { path, text }).then(() => say(`discarded lines of ${path}`), (e) => say(String(e), true));
  const after = await read().catch(() => undefined);
  await refresh();
  // a binary file has no text to put back
  if (before === undefined || after === undefined || before === after) return;
  const head = headHash(), branch = st?.branch ?? "";
  t.undo.push({ op: "discard", branch: [branch, branch], head: [head, head], file: [path, before, after] });
  t.redo = [];
  renderToolbar();
}

/* merge tool */

type Chunk = ReturnType<typeof parseConflicts>[number];
type Conflict = Exclude<Chunk, string[]>;
type Side = "a" | "b";
// the file in the merge tool: its diff3 chunks, the sides picked per conflict in click order,
// each conflict's lines in the two side panes, and its tracked range in the output
// a picked line: its side and its index in that side's conflict lines, -1 taking an empty side
type Pick = [Side, number];
// hover: the side line under the mouse, as "a:12"
let merging: { f: Change; chunks: Chunk[]; picks: Pick[][]; spans: { a: number[]; b: number[] }[]; ids: string[]; at: number; dirty: boolean; hover: string } | null = null;
let mergeEds: {
  a: Monaco.editor.IStandaloneCodeEditor;
  b: Monaco.editor.IStandaloneCodeEditor;
  out: Monaco.editor.IStandaloneCodeEditor;
  marks: Map<Monaco.editor.IStandaloneCodeEditor, Monaco.editor.IEditorDecorationsCollection>;
} | null = null;

const conflictsOf = (chunks: Chunk[]) => chunks.filter((c): c is Conflict => !Array.isArray(c));
const lineSpan = ([s, n]: number[]) => new monaco.Range(s, 1, s + n, 1);
// a conflict's box sits at the middle of its lines (class half: between the two middle ones), or on the line after an empty side
const tickLine = (ed: Monaco.editor.ICodeEditor, [s, n]: number[]) => Math.min(n ? s + Math.floor((n - 1) / 2) : s, ed.getModel()!.getLineCount());
// NeverGrowsWhenTypingAtEdges, by value: Monaco is not loaded when this runs
const tracked = { stickiness: 1 as Monaco.editor.TrackedRangeStickiness };

/** A plain editor's options, like the diff editor's. */
const plainOpts = (): Monaco.editor.IStandaloneEditorConstructionOptions => ({
  theme: "krill",
  automaticLayout: true,
  fontFamily: getComputedStyle(document.body).getPropertyValue("--mono"),
  fontSize: 13,
  scrollBeyondLastLine: false,
  stickyScroll: { enabled: false },
  contextmenu: false,
});

/** The merge tool's three editors, made on first use. */
function mergeEditors() {
  if (mergeEds) return mergeEds;
  editor();
  // no folding: its arrows would crowd the line buttons
  const opts = { ...plainOpts(), minimap: { enabled: false }, glyphMargin: true, folding: false };
  // the side panes' line buttons sit right of the line numbers
  const a = monaco.editor.create($("m-a"), { ...opts, readOnly: true, lineDecorationsWidth: 22 });
  const b = monaco.editor.create($("m-b"), { ...opts, readOnly: true, lineDecorationsWidth: 22 });
  const out = monaco.editor.create($("m-out"), opts);
  // the gutter's CSS centres the boxes and draws the bars from these
  $("merge").style.setProperty("--m-box", `${a.getLayoutInfo().glyphMarginWidth}px`);
  $("merge").style.setProperty("--m-lh", `${a.getOption(monaco.editor.EditorOption.lineHeight)}px`);
  for (const [ed, side] of [[a, "a"], [b, "b"]] as const) {
    // the box column beside a conflict picks the whole side; a line's number or button, that line
    ed.onMouseDown((e) => {
      const ln = e.target.position?.lineNumber ?? 0, T = monaco.editor.MouseTargetType;
      if (!merging) return;
      if (e.target.type === T.GUTTER_GLYPH_MARGIN) {
        // an empty side has no lines: its box is on the line after
        const k = lineIn(side, ln)?.k ?? merging.spans.findIndex((s) => !s[side][1] && tickLine(ed, s[side]) === ln);
        if (k >= 0) pick(k, side);
      } else if (e.target.type === T.GUTTER_LINE_DECORATIONS || e.target.type === T.GUTTER_LINE_NUMBERS) {
        const hit = lineIn(side, ln);
        if (hit) pickLine(hit.k, side, hit.i);
        // Monaco selects a clicked line number's line after this: drop it
        setTimeout(() => ed.setSelection(new monaco.Selection(ln, 1, ln, 1)));
      }
    });
    const hover = (ln: number) => {
      const h = merging && lineIn(side, ln) ? `${side}:${ln}` : "";
      if (merging && h !== merging.hover) (merging.hover = h), paintMerge();
    };
    ed.onMouseMove((e) => hover(e.target.position?.lineNumber ?? 0));
    ed.onMouseLeave(() => hover(0));
  }
  out.onDidChangeModelContent(() => merging && (merging.dirty = true));
  out.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveMerge());
  // the panes follow each other, matching lines across the conflicts
  const panes = [[a, "a"], [b, "b"], [out, "out"]] as const;
  let syncing = false;
  for (const [ed, from] of panes)
    ed.onDidScrollChange((e) => {
      if (syncing || !merging || !$("m-sync").classList.contains("on") || !(e.scrollTopChanged || e.scrollLeftChanged)) return;
      syncing = true;
      const lh = ed.getOption(monaco.editor.EditorOption.lineHeight), top = e.scrollTop / lh;
      for (const [other, to] of panes)
        if (other !== ed) {
          other.setScrollLeft(e.scrollLeft);
          other.setScrollTop((mapLine(Math.floor(top) + 1, from, to) - 1 + (top % 1)) * lh);
        }
      syncing = false;
    });
  mergeEds = { a, b, out, marks: new Map([a, b, out].map((ed) => [ed, ed.createDecorationsCollection()])) };
  return mergeEds;
}

/** A conflicted file: the merge tool when both sides have text, else a banner to pick a whole side. */
async function openConflict(f: Change) {
  if (merging?.f.path === f.path) return closeMerge();
  if (!(await closeMerge())) return;
  await closeDiff();
  if (cur) return;
  const text = f.conflict === "UU" || f.conflict === "AA" ? await run<Blob>("conflict_text", { path: f.path }).catch(() => null) : null;
  if (!text || text.binary) return conflictBanner(f);
  merging = { f, chunks: parseConflicts(text.text), picks: [], spans: [], ids: [], at: 0, dirty: false, hover: "" };
  $("merge").hidden = false;
  document.body.classList.add("diffing");
  $("m-path").textContent = f.path;
  $("m-a-name").textContent = opInfo?.current ?? "";
  $("m-b-name").textContent = opInfo?.incoming ?? "";
  $("m-a-commit").textContent = opInfo?.currentCommit ?? "";
  $("m-b-commit").textContent = opInfo?.incomingCommit ?? "";
  loadMerge();
  markOpenFile();
}

/** Fill the panes from the chunks, nothing picked: the output holds each conflict's base. */
function loadMerge() {
  const m = merging!, eds = mergeEditors(), s = mergeSides(m.chunks, []);
  m.picks = s.regions.map(() => []);
  m.spans = s.regions.map((r) => ({ a: r.a, b: r.b }));
  for (const [ed, text, side] of [[eds.a, s.a, "a"], [eds.b, s.b, "b"], [eds.out, s.out, "out"]] as const) {
    const old = ed.getModel();
    ed.setModel(monaco.editor.createModel(text, undefined, monaco.Uri.from({ scheme: "krill", path: `/${++seq}/${side}/${m.f.path}` })));
    old?.dispose();
  }
  // edits move the output's conflicts around: decorations keep track of them
  m.ids = eds.out.getModel()!.deltaDecorations([], s.regions.map((r) => ({ range: lineSpan(r.out), options: tracked })));
  m.dirty = false;
  paintMerge();
  goConflict(0);
}

type Pane = Side | "out";

/** Conflict `k`'s [first line, count] in a pane. */
function paneSpan(p: Pane, k: number) {
  if (p !== "out") return merging!.spans[k][p];
  const r = mergeEds!.out.getModel()!.getDecorationRange(merging!.ids[k])!;
  return [r.startLineNumber, r.endLineNumber - r.startLineNumber];
}

/** Line `l` of one pane in another: common lines match one to one, a conflict's lines go to that conflict. */
function mapLine(l: number, from: Pane, to: Pane) {
  // the first line after the previous conflict in each pane
  let f = 1, t = 1;
  for (let k = 0; k < merging!.ids.length; k++) {
    const [fs, fn] = paneSpan(from, k), [ts, tn] = paneSpan(to, k);
    if (l < fs) break;
    if (l < fs + fn) return ts + Math.min(l - fs, Math.max(tn - 1, 0));
    [f, t] = [fs + fn, ts + tn];
  }
  return t + (l - f);
}

/** The conflict and index of line `ln` of a side pane, if it is a conflict line. */
function lineIn(side: Side, ln: number) {
  const k = merging!.spans.findIndex((s) => ln >= s[side][0] && ln < s[side][0] + s[side][1]);
  return k < 0 ? null : { k, i: ln - merging!.spans[k][side][0] };
}

/** Conflict `k`'s box: add `side`'s missing lines, or drop them all. */
function pick(k: number, side: Side) {
  const m = merging!;
  m.picks[k] = toggleSide(conflictsOf(m.chunks)[k], m.picks[k], side);
  writeConflict(k);
  paintMerge();
}

/** Append line `i` of `side` to conflict `k`'s output, or drop it. */
function pickLine(k: number, side: Side, i: number) {
  const m = merging!;
  m.picks[k] = toggleLine(m.picks[k], side, i);
  writeConflict(k);
  paintMerge();
}

/** Take or drop `side` in every conflict, as the header box of its pane. */
function pickAll(side: Side) {
  const m = merging!, conflicts = conflictsOf(m.chunks), all = m.picks.every((p, k) => hasSide(conflicts[k], p, side));
  m.picks.forEach((p, k) => {
    if (all ? true : !hasSide(conflicts[k], p, side)) m.picks[k] = all ? p.filter(([s]) => s !== side) : toggleSide(conflicts[k], p, side);
    writeConflict(k);
  });
  paintMerge();
}

/** Put conflict `k`'s picked lines in the output, in place of what it held. */
function writeConflict(k: number) {
  const m = merging!, model = mergeEds!.out.getModel()!, at = model.getDecorationRange(m.ids[k])!;
  const lines = pickedLines(conflictsOf(m.chunks)[k], m.picks[k]);
  model.pushEditOperations([], [{ range: at, text: lines.join("") }], () => null);
  // the conflicts after this one moved with the edit, this one now spans its new lines
  [m.ids[k]] = model.deltaDecorations([m.ids[k]], [{ range: lineSpan([at.startLineNumber, lines.length]), options: tracked }]);
}

/** The conflicts' colors, boxes and side labels in the three panes, and the counts above them. */
function paintMerge() {
  const m = merging!, eds = mergeEds!, model = eds.out.getModel()!, conflicts = conflictsOf(m.chunks);
  const line = (l: number, options: Monaco.editor.IModelDecorationOptions) => ({ range: new monaco.Range(l, 1, l, 1), options });
  // a line of side a, b, or u (unresolved): tinted in the text and the gutter
  const reg = (side: string, on = false) => ({ isWholeLine: true, className: `m-reg-${side}${on ? " on" : ""}`, marginClassName: `m-mreg ${side}${on ? " on" : ""}` });
  // an empty side shows as a dashed line where its lines would be
  const span = (from: number, n: number, side: string, glyph?: string) =>
    n ? Array.from({ length: n }, (_, i) => line(from + i, { ...reg(side), glyphMarginClassName: glyph })) : [line(from, { isWholeLine: true, className: "m-gap" })];
  for (const side of ["a", "b"] as const) {
    const ed = eds[side];
    eds.marks.get(ed)!.set(
      m.spans.flatMap((s, k) => {
        const on = hasSide(conflicts[k], m.picks[k], side), [first, n] = s[side];
        // each line: tinted once picked, a check on it, + or − under the mouse
        const lines = Array.from({ length: n }, (_, i) => {
          const taken = m.picks[k].some(([x, j]) => x === side && j === i), hovered = m.hover === `${side}:${first + i}`;
          const button = hovered ? (taken ? "m-line drop" : "m-line add") : taken ? "m-line on" : "";
          return line(first + i, { ...reg(side, taken), linesDecorationsClassName: button || undefined });
        });
        return [
          ...(n ? lines : span(first, 0, "")),
          line(tickLine(ed, s[side]), {
            glyphMarginClassName: `m-tick${on ? " on" : ""}${n && n % 2 === 0 ? " half" : ""}`,
            glyphMarginHoverMessage: { value: on ? "Drop this side" : "Take this side" },
          }),
        ];
      }),
    );
  }
  eds.marks.get(eds.out)!.set(
    m.ids.flatMap((id, k) => {
      const r = model.getDecorationRange(id)!, p = m.picks[k];
      if (!p.length) return span(r.startLineNumber, r.endLineNumber - r.startLineNumber, "u");
      let at = r.startLineNumber;
      return p.flatMap(([side, i]) => (i < 0 ? [] : span(at++, 1, side, `m-src-${side}`)));
    }),
  );
  const left = m.picks.filter((p) => !p.length).length;
  $("m-count").textContent = `${m.ids.length} conflict${m.ids.length === 1 ? "" : "s"}${left ? `, ${left} without a pick` : ""}`;
  for (const side of ["a", "b"] as const) input(`m-all-${side}`).checked = m.picks.length > 0 && m.picks.every((p, k) => hasSide(conflicts[k], p, side));
  $("m-at").textContent = m.ids.length ? `conflict ${m.at + 1} of ${m.ids.length}` : "";
}

function goConflict(i: number) {
  const m = merging!, eds = mergeEds!;
  if (!m.ids.length) return;
  m.at = (i + m.ids.length) % m.ids.length;
  eds.out.revealLineInCenter(eds.out.getModel()!.getDecorationRange(m.ids[m.at])!.startLineNumber);
  eds.a.revealLineInCenter(m.spans[m.at].a[0]);
  eds.b.revealLineInCenter(m.spans[m.at].b[0]);
  $("m-at").textContent = `conflict ${m.at + 1} of ${m.ids.length}`;
}

/** Write the output and mark the file resolved. */
async function saveMerge() {
  const m = merging;
  if (!m) return;
  const left = m.picks.filter((p) => !p.length).length;
  if (left && !(await ask(`${left} conflict${left === 1 ? " still holds" : "s still hold"} the base version. Save anyway?`, "Save"))) return;
  const text = mergeEds!.out.getModel()!.getValue(monaco.editor.EndOfLinePreference.TextDefined, true);
  try {
    await run("write_file", { path: m.f.path, text });
  } catch (e) {
    return say(String(e), true);
  }
  await closeMerge(true);
  op("stage", m.f.path);
}

async function closeMerge(force = false) {
  if (!merging) return true;
  if (!force && merging.dirty && !(await ask(`Drop the merge of ${merging.f.path}?`, "Drop"))) return false;
  merging = null;
  $("merge").hidden = true;
  document.body.classList.remove("diffing");
  markOpenFile();
  return true;
}

/** No line-by-line merge for this file: say why and offer whole versions. */
function conflictBanner(f: Change) {
  const cur = opInfo?.current || "current", inc = opInfo?.incoming || "incoming";
  const [text, choices]: [string, [string, string][]] =
    f.conflict === "DU"
      ? [`${f.path} was modified on ${inc}, but deleted on ${cur}.`, [["Keep modified version", "take-incoming"], ["Delete the file", "take-current"], ["Keep base version", "take-base"]]]
      : f.conflict === "UD"
        ? [`${f.path} was modified on ${cur}, but deleted on ${inc}.`, [["Keep modified version", "take-current"], ["Delete the file", "take-incoming"], ["Keep base version", "take-base"]]]
        : f.conflict === "DD"
          ? [`${f.path} was deleted on both sides.`, [["Delete the file", "take-current"]]]
          : f.conflict === "AU"
            ? [`${f.path} was added on ${cur} only.`, [["Keep the file", "take-current"], ["Delete the file", "take-incoming"]]]
            : f.conflict === "UA"
              ? [`${f.path} was added on ${inc} only.`, [["Keep the file", "take-incoming"], ["Delete the file", "take-current"]]]
              : [`${f.path} cannot be merged line by line (binary or not UTF-8).`, [[`Take current (${cur})`, "take-current"], [`Take incoming (${inc})`, "take-incoming"]]];
  const close = () => ($("banner").hidden = true);
  $("banner").replaceChildren(
    h("span", { textContent: text }),
    ...choices.map(([label, o]) => h("button", { textContent: label, onclick: () => (close(), op(o, f.path)) })),
    h("button", { textContent: "Cancel", onclick: close }),
  );
  $("banner").hidden = false;
}

/* terminal */

/* file history */

type Blamed = { hash: string; author: string; time: number; summary: string };
// the file's commits newest first, each with the file's name there, the one shown and its blame
let hist: { path: string; revs: [Commit, Change][]; at: number; blame: Blamed[] } | null = null;
let histEd: Monaco.editor.IStandaloneCodeEditor | null = null;
let blameHovers: Monaco.editor.IEditorDecorationsCollection | null = null;
// the blame text: subject, two spaces, date
const BLAME_SUBJECT = 28, BLAME_W = BLAME_SUBJECT + 12;
// the blame strips' colors, one class per palette entry
document.head.append(h("style", { textContent: COLORS.map((c, i) => `.bl-c${i} { background: ${c}; }`).join("\n") }));

/** The commits that touched `path`, from HEAD and from `c` when given, with the file at each; uncommitted changes on top. */
async function openHistory(path: string, c?: Commit) {
  await loadMonaco();
  if (!(await closeMerge())) return;
  let revs: [Commit, Change][];
  try {
    revs = await run<[Commit, Change][]>("file_log", { revs: c ? ["HEAD", c.hash] : ["HEAD"], path });
  } catch (e) {
    return say(String(e), true);
  }
  // closed only now: the graph would show while git log runs
  await closeDiff();
  if (cur) return;
  // the working tree file as a commit on top of HEAD: blob and diff take WORKTREE as a revision
  if (wipFiles().some((f) => f.path === path))
    revs.unshift([{ hash: "WORKTREE", parents: ["HEAD"], author: "", time: 0, refs: [], subject: "Uncommitted changes", body: "" }, { path, old: null, code: "M" }]);
  if (!revs.length) return say(`${path} has no commits yet`);
  hist = { path, revs, at: -1, blame: [] };
  $("h-path").textContent = `File history: ${path}`;
  $("h-list").replaceChildren(
    ...revs.map(([r, f], i) =>
      h("div", { className: "h-row", title: f.old ? `${f.old} → ${f.path}` : f.path, onclick: () => showRev(i) },
        r.time ? avatar(r.author) : h("span", { className: "avatar wip" }),
        h("div", {}, h("div", { textContent: r.subject }), h("small", { textContent: r.time ? `${dateFmt.format(r.time * 1000)} by ${r.author}` : "Working tree" })),
        h("code", { textContent: r.time ? short(r.hash) : "" }),
      ),
    ),
  );
  // the history's file and diff show in the diff's pane, next to its list
  $("h-main").append($("diff"));
  $("h-main").classList.add("blank");
  $("hist").hidden = false;
  document.body.classList.add("history");
  showRev(Math.max(0, revs.findIndex(([r]) => r.hash === c?.hash)));
}

/** Show the file at the history's `i`th commit, or that commit's diff of it. */
async function showRev(i: number) {
  const m = hist;
  if (!m || i === m.at || !m.revs[i]) return;
  m.at = i;
  $("h-list").querySelectorAll(".h-row").forEach((r, k) => r.classList.toggle("on", k === i));
  $("h-list").children[i].scrollIntoView({ block: "nearest" });
  const [c, f] = m.revs[i];
  if (store("hist-view") === "diff") {
    // openDiff closes a diff opened again
    const opening = cur?.c?.hash !== c.hash;
    if (opening) await openDiff("commit", f, c, true);
    if (hist !== m || m.at !== i) return;
    histPane(false);
    return reveal(opening ? diffDrawn() : undefined);
  }
  await closeDiff(true);
  histPane(true);
  $("d-path").textContent = `${f.path} · ${short(c.hash)}`;
  const [blob, blame] = await Promise.all([
    run<Blob>("blob", { at: c.hash, path: f.path }),
    run<string>("blame", { at: c.hash, path: f.path }).catch(() => ""),
  ]).catch((e) => (say(String(e), true), [null, ""] as const));
  if (hist !== m || m.at !== i || !blob) return;
  m.blame = parseBlame(blame) as Blamed[];
  // git's zero hash for uncommitted lines: the WIP row
  const wip = m.blame.find((b) => b && /^0+$/.test(b.hash));
  if (wip) Object.assign(wip, { hash: "WORKTREE", summary: "Uncommitted changes" });
  const ed = historyEditor(), view = ed.saveViewState(), old = ed.getModel();
  const text = blob.binary ? "Binary or non-UTF-8 file" : blob.exists ? blob.text : `Deleted in ${short(c.hash)}`;
  ed.setModel(monaco.editor.createModel(text, undefined, monaco.Uri.from({ scheme: "krill", path: `/${++seq}/h/${f.path}` })));
  old?.dispose();
  // another version of the same file: stay around the same lines
  if (view) ed.restoreViewState(view);
  paintBlame();
  reveal();
}

/** The diff's pane holds the file view too: the bar stays, with the diff options dimmed. */
function histPane(file: boolean) {
  $("diff").hidden = false;
  $("h-file").hidden = !file;
  if (file) $("editor").hidden = $("binary").hidden = true;
  dimDiffOpts(file);
}

const dimDiffOpts = (dim: boolean) =>
  [$("prev-change"), $("next-change"), ...document.querySelectorAll<HTMLElement>("[data-mode]")].forEach((b) => b.classList.toggle("off", dim));

/** Show the history's pane once `drawn` settles, a frame later so it is painted. */
const reveal = (drawn?: Promise<unknown>) => (drawn ?? Promise.resolve()).then(() => requestAnimationFrame(() => $("h-main").classList.remove("blank")));

// a diff's hunks and folds land a moment after its text
const diffDrawn = () =>
  new Promise((done) => {
    // the first update only drops the old diff: wait for one with changes computed
    const d = editor().onDidUpdateDiff(() => editor().getLineChanges() && (d.dispose(), done(0)));
    setTimeout(() => (d.dispose(), done(0)), 500);
  });

function historyEditor() {
  if (histEd) return histEd;
  editor();
  histEd = monaco.editor.create($("h-file"), { ...plainOpts(), readOnly: true, minimap: { renderCharacters: false, showSlider: "always" } });
  // a click in the blame gutter shows the line's commit
  histEd.onMouseDown((e) => {
    if (!hist || e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) return;
    const b = hist.blame[e.target.position!.lineNumber - 1];
    const i = hist.revs.findIndex(([c]) => c.hash === b?.hash);
    if (i >= 0) showRev(i);
  });
  blameHovers = histEd.createDecorationsCollection();
  return histEd;
}

/** An avatar where each commit's lines start, and its subject and date with Blame on. */
function paintBlame() {
  const m = hist!, on = store("blame") === "on", digits = String(histEd!.getModel()!.getLineCount()).length;
  // ponytail: Monaco inserts the line number string as HTML, so the gutter is drawn as text; a view zone per line if it starts escaping
  histEd!.updateOptions({
    lineNumbersMinChars: (on ? BLAME_W + 1 : 0) + 4 + digits,
    lineNumbers: (n) => {
      const b = m.blame[n - 1], first = !!b && m.blame[n - 2]?.hash !== b.hash;
      const num = String(n).padStart(digits);
      if (!first) return `<span class="bl-av"></span> ${on ? " ".repeat(BLAME_W + 1) : ""} ${num}`;
      const text = on ? `${b.summary.slice(0, BLAME_SUBJECT).padEnd(BLAME_SUBJECT)}  ${dayFmt.format(b.time * 1000).padEnd(10)} ` : "";
      return `${avatarSvg(b.author, "bl-av")} ${esc(text)} ${num}`;
    },
  });
  // who and when over each run of lines from one commit, and its strip, colored by its row
  const md = (s: string) => s.replace(/[\\`*_{}[\]()#+\-.!<>|~]/g, "\\$&");
  const color = (hash: string) => {
    const row = m.revs.findIndex(([c]) => c.hash === hash);
    return row < 0 ? hue(hash) : row % COLORS.length;
  };
  blameHovers!.set(
    m.blame.flatMap((b, k) => {
      if (!b || m.blame[k - 1]?.hash === b.hash) return [];
      let end = k;
      while (m.blame[end + 1]?.hash === b.hash) end++;
      const value = `**${md(b.author)}**, ${dateFmt.format(b.time * 1000)} · \`${short(b.hash)}\`\n\n${md(b.summary)}`;
      const options = { lineNumberHoverMessage: { value }, linesDecorationsClassName: `bl-strip bl-c${color(b.hash)}` };
      return [{ range: new monaco.Range(k + 1, 1, end + 1, 1), options }];
    }),
  );
}

/** Blame's three states: on, off, and dimmed in the diff view. */
function paintBlameBtn() {
  const b = $("h-blame"), diff = store("hist-view") === "diff", on = store("blame") === "on";
  // a class, not `disabled`: WebKit shows no tooltip on a disabled button
  b.classList.toggle("off", diff);
  b.classList.toggle("on", on && !diff);
  b.title = diff ? "Blame: only in the File view" : on ? "Hide each line's commit" : "Show each line's commit next to it";
}

function histView(v: string) {
  if (hist && store("hist-view") === v) return;
  store("hist-view", v);
  document.querySelectorAll<HTMLElement>("[data-hview]").forEach((b) => b.classList.toggle("on", b.dataset.hview === v));
  paintBlameBtn();
  if (!hist) return;
  const i = hist.at;
  hist.at = -1;
  $("h-main").classList.add("blank");
  showRev(i);
}

async function closeHistory() {
  await closeDiff(true);
  $("h-file").hidden = true;
  dimDiffOpts(false);
  hist = null;
  $("hist").hidden = true;
  document.body.classList.remove("history");
  $("merge").before($("diff"));
}

const termTheme = {
  background: "#1b1f27",
  foreground: "#e4e8ef",
  cursor: "#1a9ea6",
  selectionBackground: "#1a9ea666",
  black: "#2c323d",
  red: "#ff5470",
  green: "#3ee88f",
  yellow: "#ffcf3f",
  blue: "#4f8cff",
  magenta: "#b467ff",
  cyan: "#26d4ca",
  white: "#e4e8ef",
  brightBlack: "#5d6575",
};

/** The tab's shell, started on first use in its repo. */
function termFor(tab: Tab) {
  const known = terms.get(tab);
  if (known) return known;
  const el = h("div", { className: "term" });
  $("term").append(el);
  const term = new Terminal({ fontFamily: getComputedStyle(document.body).getPropertyValue("--mono"), fontSize: 13, theme: termTheme, cursorBlink: true });
  const t: Term = { term, fit: new FitAddon(), el, id: 0, armed: false };
  terms.set(tab, t);
  term.loadAddon(t.fit);
  term.open(el);
  t.fit.fit();
  // a command typed here may change the repo: refresh once its output settles
  const settle = () => {
    clearTimeout(termIdle);
    termIdle = setTimeout(() => {
      t.armed = false;
      if (tab === tabs[active]) refresh();
    }, 400);
  };
  const out = new Channel<ArrayBuffer>();
  out.onmessage = (b) => {
    if (!b.byteLength) return (dropTerm(tab), tab === tabs[active] && toggleTerm(false));
    term.write(new Uint8Array(b));
    if (t.armed) settle();
  };
  invoke<number>("pty_spawn", { repo: tab.repo, cols: term.cols, rows: term.rows, onData: out })
    .then((id) => (t.id = id))
    .catch((e) => say(String(e), true));
  term.onData((data) => {
    if (!t.id) return;
    invoke("pty_write", { id: t.id, data });
    if (data.includes("\r")) (t.armed = true), settle();
  });
  term.onResize(({ cols, rows }) => t.id && invoke("pty_resize", { id: t.id, cols, rows }));
  term.attachCustomKeyEventHandler((e) => !(e.ctrlKey && (e.code === "Backquote" || e.key === "Tab")));
  return t;
}

function dropTerm(tab: Tab) {
  const t = terms.get(tab);
  if (!t) return;
  terms.delete(tab);
  if (t.id) invoke("pty_kill", { id: t.id });
  t.term.dispose();
  t.el.remove();
}

/** Show the bottom panel with the active tab's shell when the panel is open. */
function showTerm(focus: boolean) {
  const open = !!store("term") && !!repo;
  $("term").hidden = !open;
  $("term-btn").classList.toggle("on", open);
  terms.forEach((t, tab) => (t.el.hidden = tab !== tabs[active]));
  if (!open) return;
  // paint the panel first: xterm's setup and the shell spawn take a moment
  requestAnimationFrame(() =>
    setTimeout(() => {
      if ($("term").hidden || !repo) return;
      const t = termFor(tabs[active]);
      t.el.hidden = false;
      t.fit.fit();
      if (focus) t.term.focus();
    }),
  );
}

function toggleTerm(open = $("term").hidden) {
  store("term", open ? "1" : "");
  showTerm(open);
}

/** Mark the commits matching the search box; non-matching rows dim. */
function markHits() {
  const q = input("find-q").value.trim().toLowerCase();
  hits = q
    ? commits.filter((c) => c.hash.startsWith(q) || `${c.subject}\n${c.body}\n${c.author}\n${c.refs.join(" ")}`.toLowerCase().includes(q)).map((c) => c.hash)
    : [];
  const set = new Set(hits);
  $("rows").classList.toggle("finding", !!q);
  document.querySelectorAll<HTMLElement>("#rows .row").forEach((r) => r.classList.toggle("match", set.has(r.dataset.hash!)));
  $("find-n").textContent = q ? `${hits.length ? hit + 1 : 0}/${hits.length}` : "";
}

function findStep(step: number) {
  if (!hits.length) return;
  hit = (hit + step + hits.length) % hits.length;
  $("find-n").textContent = `${hit + 1}/${hits.length}`;
  jumpTo(hits[hit]);
}

function openFind() {
  $("find").hidden = false;
  input("find-q").select();
  input("find-q").focus();
}

function closeFind() {
  $("find").hidden = true;
  $("rows").classList.remove("finding");
}

/** Up/Down walk the graph, or the files once Right opened one; Left goes back to the graph. */
function arrow(key: string) {
  if (hist) return key === "ArrowUp" || key === "ArrowDown" ? showRev(hist.at + (key === "ArrowDown" ? 1 : -1)) : undefined;
  if (key === "ArrowLeft") return closeDiff();
  const down = key === "ArrowDown";
  const inFiles = !!openFile();
  // every file of the visible lists, folded folders included: moving onto one unfolds it
  const files = ["unstaged", "staged", "c-files"]
    .filter((id) => $(id).offsetParent)
    .flatMap((id) => (fileLists.get($(id))?.order ?? []).map((f) => ({ id, f })));
  if (key === "ArrowRight") return inFiles || (files[0] && openListed(files[0].id, files[0].f));
  if (inFiles) {
    const open = openFile()!, id = open.kind === "commit" ? "c-files" : open.kind;
    const next = files[files.findIndex((x) => x.id === id && x.f.path === open.f.path) + (down ? 1 : -1)];
    return next && openListed(next.id, next.f);
  }
  const i = shown.findIndex((c) => c.hash === anchor);
  const next = shown[i < 0 ? 0 : i + (down ? 1 : -1)];
  if (!next) return;
  showRow(next.hash, "nearest");
  document.querySelector<HTMLElement>(`.row[data-hash="${next.hash}"]`)?.click();
}

function openListed(id: string, f: Change) {
  fileLists.get($(id))?.reveal(f.path);
  const row = $(id).querySelector<HTMLElement>(`.file[data-path="${CSS.escape(f.path)}"]`);
  row?.click();
  row?.scrollIntoView({ block: "nearest" });
}

/** Lay the shown editors out now: Monaco's own resize handling waits a frame, which flickers while dragging. */
function relayout() {
  for (const ed of [diffEditor, histEd, mergeEds?.a, mergeEds?.b, mergeEds?.out]) if (ed?.getContainerDomNode().offsetParent) ed.layout();
}

/** Drag `grip` to size `prop` of `box` (a height, or a column width variable), kept across runs. */
function resizer(grip: HTMLElement, box: HTMLElement, key: string, size: (m: PointerEvent) => number, prop = "height") {
  box.style.setProperty(prop, store(key) ?? "");
  grip.onpointerdown = (e) => {
    // else the drag selects the text it crosses
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.onpointermove = (m) => {
      box.style.setProperty(prop, `${size(m)}px`);
      relayout();
    };
    grip.onpointerup = () => {
      grip.onpointermove = null;
      store(key, box.style.getPropertyValue(prop));
    };
  };
}

/* wiring */

document.querySelectorAll<HTMLElement>("[data-op]").forEach((b) => (b.onclick = () => (b.dataset.op === "push" ? push() : b.dataset.op === "pull" ? pull() : op(b.dataset.op!))));
$("pull-mode").onclick = pullMenu;
paintPull();
// when each repository was last fetched in the background
const fetchedAt = new Map<string, number>();
// repositories whose background fetch was told to need a passphrase or password, once a run
const toldAuth = new Set<string>();
/** A quiet fetch of the open repository, at most once a minute each: ahead/behind and remote branches stay fresh; failures (offline) stay silent. */
function autoFetch() {
  const r = repo;
  if (!r || Date.now() - (fetchedAt.get(r) ?? 0) < 60_000 || document.body.classList.contains("busy")) return;
  fetchedAt.set(r, Date.now());
  run("git_op", { op: "auto-fetch", arg: "" }).then(
    () => void (r === repo && refresh()),
    (e) => {
      if (!String(e).includes("krill: needs a passphrase or password") || toldAuth.has(r)) return;
      toldAuth.add(r);
      toast(`Auto-fetch skipped: ${aliases()[r] ?? basename(r)}`, "Its remote needs a passphrase or password, which a background fetch cannot ask for. Use Fetch to enter it.", "info");
    },
  );
}
addEventListener("focus", () => autoFetch());
setInterval(() => autoFetch(), 5 * 60_000);
document.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => (b.onclick = () => b.classList.contains("off") || setMode(b.dataset.mode as Mode)));
$("new-tab").onclick = addTab;
$("graph").addEventListener("scroll", () => drawRows(), { passive: true });
window.addEventListener("resize", () => drawRows());
$("tab-find").onclick = () => {
  $("tab-search").hidden = !$("tab-search").hidden;
  input("tab-q").value = "";
  renderTabHits();
  input("tab-q").focus();
};
$("tab-q").oninput = renderTabHits;
$("dialog").onclick = (e) => {
  // a click on the dimmed backdrop closes it
  if (e.target === $("dialog")) closeDialog();
};
$("tab-q").onkeydown = (e) => {
  if (e.key === "Enter") $("tab-hits").querySelector<HTMLElement>(".tab-hit")?.click();
};
$("find-q").oninput = () => {
  hit = -1;
  markHits();
  findStep(1);
};
$("find-q").onkeydown = (e) => {
  if (e.key === "Enter") findStep(e.shiftKey ? -1 : 1);
};
$("find-prev").onclick = () => findStep(-1);
$("find-next").onclick = () => findStep(1);
$("find-close").onclick = closeFind;
document.querySelectorAll<HTMLInputElement>(".file-filter").forEach(
  (f) =>
    (f.oninput = () => {
      fileQuery = f.value.trim().toLowerCase();
      document.querySelectorAll<HTMLInputElement>(".file-filter").forEach((o) => (o.value = f.value));
      renderPanel();
    }),
);
$("stage-all").onclick = () => op(conflictCount() ? "resolve-all" : "stage-all");
$("op-continue").onclick = () => {
  if ($("op-continue").classList.contains("off")) return say($("op-continue").title);
  // git refuses to continue an empty step and says to skip it
  if (emptyStep()) return op("skip");
  // a rebase step keeps its own message unless reworded
  const msg = getMsg().trim(), keep = opInfo?.state !== "merge" && msg === opInfo?.message.trim();
  op("continue", keep ? "" : msg);
};
$("op-skip").onclick = () => op("skip");
$("op-abort").onclick = () => ask(`Abort the ${opInfo?.state}? What it did so far is dropped.`, "Abort").then((ok) => ok && op("abort"));
$("opstate").onclick = () => {
  stashView = null;
  selected = [(anchor = "WIP")];
  paintSelection();
  showRow("WIP", "nearest");
  renderPanel();
};
$("m-close").onclick = () => closeMerge();
$("m-save").onclick = () => saveMerge();
$("m-reset").onclick = () => merging && loadMerge();
$("m-prev").onclick = () => merging && goConflict(merging.at - 1);
$("m-next").onclick = () => merging && goConflict(merging.at + 1);
input("m-all-a").onchange = () => pickAll("a");
input("m-all-b").onchange = () => pickAll("b");
$("discard-all").onclick = () =>
  ask("Discard ALL changes: staged, unstaged and untracked files? This cannot be undone.", "Discard all").then((ok) => ok && op("discard-all"));
$("unstage-all").onclick = () => op("unstage-all");
$("commit-btn").onclick = commit;
for (const id of ["summary", "desc"]) {
  $(id).onkeydown = (e) => {
    // a handler returning false cancels the key, so no expression body here
    if (e.ctrlKey && e.key === "Enter") commit();
  };
}
$("summary").oninput = renderCommitBtn;
$("amend").onclick = async () => {
  $("amend").classList.toggle("on");
  renderCommitBtn();
  if (!amending() || getMsg()) return;
  const info = await run<{ message: string }>("commit_info", { hash: "HEAD", parent: "" }).catch(() => null);
  if (info) setMsg(info.message);
};
$("term-btn").onclick = () => toggleTerm();
$("term-close").onclick = () => toggleTerm(false);
$("undo").onclick = () => walk(true);
$("redo").onclick = () => walk(false);
$("all-files").onclick = () => ($("all-files").classList.toggle("on"), renderPanel());
document.querySelectorAll<HTMLElement>("[data-files]").forEach(
  (b) =>
    (b.onclick = () => {
      store("files-view", b.dataset.files!);
      paintFileOpts();
      renderPanel();
    }),
);
document.querySelectorAll<HTMLElement>(".files-opts .sort").forEach(
  (b) =>
    (b.onclick = () => {
      const keys = Object.keys(SORTS);
      store("files-sort", keys[(keys.indexOf(store("files-sort") ?? "") + 1) % keys.length]);
      paintFileOpts();
      renderPanel();
    }),
);
document.querySelectorAll<HTMLElement>(".tree-all").forEach(
  (b) =>
    (b.onclick = () => {
      if (b.classList.contains("off")) return say(b.title);
      treeOpen = !!b.dataset.open;
      flipped.clear();
      renderPanel();
    }),
);
paintFileOpts();
resizer($("term-grip"), $("term"), "term-height", (m) =>
  Math.min($("center").clientHeight - 120, Math.max(80, $("term").getBoundingClientRect().bottom - m.clientY)),
);
resizer($("c-grip"), $("c-msg"), "msg-height", (m) => Math.min(innerHeight * 0.6, Math.max(60, m.clientY - $("c-msg").getBoundingClientRect().top)));
const main = document.querySelector("main")!;
resizer($("side-grip"), main, "side-width", (m) => Math.min(480, Math.max(160, m.clientX)), "--side-w");
resizer($("panel-grip"), main, "panel-width", (m) => Math.min(innerWidth * 0.5, Math.max(300, innerWidth - m.clientX)), "--panel-w");
new ResizeObserver(() => terms.get(tabs[active])?.fit.fit()).observe($("term"));
$("close").onclick = () => closeDiff();
$("d-history").onclick = () => cur && openHistory(cur.f.path, cur.c);
$("h-close").onclick = () => closeHistory();
document.querySelectorAll<HTMLElement>("[data-hview]").forEach((b) => (b.onclick = () => histView(b.dataset.hview!)));
histView(store("hist-view") ?? "file");
resizer($("h-grip"), $("hist"), "hist-width", (m) => Math.min(innerWidth * 0.6, Math.max(220, m.clientX - $("hist").getBoundingClientRect().left)), "--hl-w");
$("h-blame").onclick = () => {
  if (store("hist-view") === "diff") return;
  store("blame", store("blame") === "on" ? "off" : "on");
  paintBlameBtn();
  if (hist && histEd?.getModel()) paintBlame();
};
$("prev-change").onclick = () => cur && editor().goToDiff("previous");
$("next-change").onclick = () => cur && editor().goToDiff("next");
$("open-editor").onclick = () => {
  if (!cur) return;
  if ($("open-editor").classList.contains("off")) return say($("open-editor").title);
  const line = editor().getModifiedEditor().getPosition()?.lineNumber ?? 1;
  run("open_in_editor", { path: cur.f.path, line }).catch((e) => say(String(e), true));
};
$("save").onclick = () => save().then(refresh);
$("refresh").onclick = refresh;
const openPicked = async () => {
  const p = await pickDir("Open repository");
  if (p) await openRepo(p);
};
$("open-repo").onclick = openPicked;
$("m-sync").classList.toggle("on", store("merge-sync") !== "off");
$("m-sync").onclick = () => store("merge-sync", $("m-sync").classList.toggle("on") ? "on" : "off");
$("init-repo").onclick = async () => {
  const p = await pickDir("Folder to init");
  if (!p) return;
  try {
    await invoke("init", { path: p });
    await openRepo(p);
  } catch (e) {
    say(String(e), true);
  }
};
$("clone-btn").onclick = cloneDialog;
addEventListener("focus", refresh);
addEventListener("click", (e) => {
  $("menu").hidden = $("submenu").hidden = true;
  if (!(e.target as HTMLElement).closest("#tab-search, #tab-find")) $("tab-search").hidden = true;
});
// WebKit's Reload/Back menu means nothing here; inputs and Monaco keep theirs
addEventListener("contextmenu", (e) => !(e.target as HTMLElement).closest("input, textarea, #editor") && e.preventDefault());
addEventListener("keydown", (e) => {
  const key = e.key.toLowerCase();
  if (e.ctrlKey && e.code === "Backquote") (e.preventDefault(), toggleTerm());
  // GTK turns Shift+Tab into ISO_Left_Tab: the physical key is the sure one
  else if (e.ctrlKey && e.code === "Tab") (e.preventDefault(), switchTab((active + (e.shiftKey ? tabs.length - 1 : 1)) % tabs.length));
  // the shell owns every other key
  else if ((e.target as HTMLElement).closest?.("#term")) return;
  else if (e.key === "F5") (e.preventDefault(), refresh());
  else if (e.ctrlKey && e.shiftKey && key === "t") (e.preventDefault(), reopenTab());
  else if (e.ctrlKey && key === "t") (e.preventDefault(), addTab());
  else if (e.ctrlKey && key === "o") (e.preventDefault(), openPicked());
  else if (e.ctrlKey && key === "w") (e.preventDefault(), closeTab(active));
  else if (e.key === "Escape") {
    if (!$("menu").hidden) $("menu").hidden = $("submenu").hidden = true;
    else if (!$("banner").hidden) $("banner").hidden = true;
    else if (!$("dialog").hidden) closeDialog();
    else if (!$("tab-search").hidden) $("tab-search").hidden = true;
    else if (!$("find").hidden && !openFile()) closeFind();
    else if (hist) closeHistory();
    else if (!$("diff").hidden) closeDiff();
    else if (merging) closeMerge();
  } else if ((e.target as HTMLElement).closest?.("input:not([type=checkbox]), textarea, #editor, #merge, #h-file") || !repo) return;
  else if (e.ctrlKey && key === "f") (e.preventDefault(), openFind());
  else if (e.ctrlKey && key === "z") (e.preventDefault(), walk(!e.shiftKey));
  else if (e.ctrlKey && key === "y") (e.preventDefault(), walk(false));
  else if (e.key.startsWith("Arrow") && !e.ctrlKey && !e.altKey && !e.shiftKey) (e.preventDefault(), arrow(e.key));
});

// warm Monaco and its diff worker up front: a cold first diff took ~0.5 s
setTimeout(async () => {
  await loadMonaco();
  if (!diffEditor) editor().setModel({ original: monaco.editor.createModel("a"), modified: monaco.editor.createModel("b") });
}, 1000);

(async () => {
  tabs = (JSON.parse(store("tabs") ?? "[]") as string[]).map(newTab);
  if (!tabs.length) tabs.push(newTab(""));
  active = Math.min(Number(store("active")) || 0, tabs.length - 1);
  const arg = await invoke<string>("initial_repo");
  if (!arg || !(await openRepo(arg))) await switchTab(active, false);
})();
