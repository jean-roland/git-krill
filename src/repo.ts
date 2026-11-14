// The open repository: shared state, git ops, refresh, undo, pull/push, tabs and the home screen.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { repoName } from "./core.js";
import { $, COLORS, ICONS, MenuItem, ask, basename, colorIndex, dialog, h, hideBanner, hideDialog, hint, ico, input, pickDir, plural, popup, say, short, showBanner, showDialog, showMenu, store, svg, toast, warnOnce } from "./ui";
import { closeHistory, closeMerge, closeResolvedMerge, confirmDrop, diffFile, openRow, reloadDiff } from "./diff";
import { conflictCount, getMsg, renderPanel, setMsg } from "./panel";
import { stepBack, paintWipRow, renderGraph, renderSide, resetGraph } from "./graph";
import { dropTerm, showTerm } from "./terminal";
import { renderSettings, rerereTip } from "./settings";

// lfs: git-lfs stores it
// sub: in a commit, whether git recorded a submodule there; the work tree asks today's list
export type Change = { path: string; old: string | null; code: string; conflict?: string; lfs?: boolean; sub?: boolean };
type OpInfo = { state: string; current: string; incoming: string; currentCommit: string; incomingCommit: string; step: string; message: string };
export type Commit = { hash: string; parents: string[]; author: string; time: number; refs: string[]; subject: string; body: string };
export type Status = { branch: string; state: string; ahead: number | null; behind: number | null; staged: Change[]; unstaged: Change[] };
type Ref = { name: string; hash: string; upstream: string; track: string };
export type Stash = { name: string; hash: string; parents: string[]; subject: string };
export type Worktree = { path: string; head: string; branch: string; locked: boolean; prunable: boolean };
// head: the commit checked out in it, empty when not initialized
export type Submodule = { name: string; path: string; url: string; recorded: string; head: string; modified: boolean; untracked: boolean; ahead: number | null; behind: number | null };
type Refs = { refs: Ref[]; stashes: Stash[]; remotes: string[]; worktrees: Worktree[]; submodules: Submodule[]; superproject: string; repoTop: string; lfs: boolean; lfsProblem: string };
// large: too big to load unasked, its size in bytes
// lfs: a git-lfs pointer in git, "here" when its object was read instead, "missing" when it is not downloaded
export type Blob = { text: string; exists: boolean; binary: boolean; large: number | null; lfs: "" | "here" | "missing" };
// what: the menu's name for it, the commit made or where HEAD went; file: a discard, the work tree text before and after (null: no file)
type UndoStep = { op: string; what: string; branch: [string, string]; head: [string, string]; file?: [string, string | null, string | null] };
// limit: how many commits the graph loads, raised by "Load more"
// parent: what this tab steps back to, the main checkout of a worktree or the repository a submodule was opened from in it; one level only
// settings: the Settings tab, which has no repository either; back: the tab as it was before stepping into a worktree or submodule
export type Tab = { repo: string; parent: string; selected: string[]; msg: string; scroll: number; undo: UndoStep[]; redo: UndoStep[]; worktree: boolean; limit: number; settings: boolean; back?: Tab };
export const LOG_LIMIT = 3000;
// ops that move HEAD, walked back with a reset or a checkout
const UNDOABLE = new Set([
  "commit", "amend", "reword", "checkout", "merge", "rebase", "rebase-interactive", "cherry-pick", "pull",
  "branch-create", "reset-soft", "reset-mixed", "reset-hard", "revert",
]);
const KEEP_INDEX = new Set(["commit", "amend", "reword", "reset-soft", "reset-mixed"]);
// ops named in the Undo menu by the commit they made
const MAKE_COMMIT = new Set(["commit", "amend", "reword", "revert", "cherry-pick"]);
// ops whose result is on a remote or gone from view: a toast confirms them, from (arg, arg2, branch, its upstream)
const DONE: Record<string, (arg: string, arg2: string, branch: string, upstream: string) => string> = {
  push: (_a, _b, branch, upstream) => `Pushed ${branch} to ${upstream}`,
  "push-force": (_a, _b, branch, upstream) => `Force pushed ${branch} to ${upstream}`,
  "push-upstream": (remote, name, branch) => `Pushed ${branch} to ${remote}/${name}`,
  "push-delete": (remote, name) => `Deleted ${name.replace(/^refs\/tags\//, "tag ")} on ${remote}`,
  "tag-push": (remote, name) => `Pushed tag ${name} to ${remote}`,
  "tag-delete": (name) => `Deleted tag ${name}`,
  "tag-rename": (name, to) => `Renamed tag ${name} to ${JSON.parse(to)[0]}`,
  "branch-delete": (name) => `Deleted branch ${name}`,
  "branch-force-delete": (name) => `Deleted branch ${name}`,
  "worktree-add": (path, branch) => `Created worktree ${basename(path)} on ${branch}`,
  "worktree-add-new": (path, spec) => `Created worktree ${basename(path)} on the new branch ${JSON.parse(spec)[0]}`,
  "worktree-remove": (path) => `Removed worktree ${basename(path)}`,
  "worktree-force-remove": (path) => `Removed worktree ${basename(path)}`,
  "worktree-prune": () => "Pruned the worktrees whose folder is gone",
  "lfs-pull": () => "Pulled the LFS files",
  "lfs-fetch": () => "Downloaded the LFS files",
  "lfs-prune": () => "Pruned the LFS files",
  "submodule-add": (_url, path) => `Added submodule ${path}: commit to record it`,
};
// what to do when git-lfs cannot serve a repository that uses it, by refs' lfsProblem
const LFS_PROBLEMS: Record<string, string> = {
  missing: "git-lfs is not installed: its large files show as small pointer files. Install git-lfs, run `git lfs install` once, then Pull LFS files.",
  unset: "git-lfs is installed but not set up: run `git lfs install` once, then Pull LFS files.",
};
// the chip's short take on LFS_PROBLEMS; git-lfs is looked for once per run
const LFS_CHIP_TIPS: Record<string, string> = {
  missing: "This file uses Git LFS, which is not installed: install it and restart Git Krill",
  unset: "This file uses Git LFS, which is not set up: run `git lfs install` once",
};
/** A chip marking a file git-lfs stores: struck out in red while git-lfs cannot serve the repository. */
export function lfsChip() {
  const why = LFS_CHIP_TIPS[refs.lfsProblem];
  return h("small", { className: why ? "lfs broken" : "lfs", textContent: "LFS", title: why ?? "Stored with Git LFS" });
}
// what may change the remotes' tags, or the list of them
const NET_OPS = new Set(["fetch", "fetch-remote", "pull", "push", "push-force", "push-upstream", "tag-push", "push-delete", "tag-rename"]);
// how Pull reconciles a diverged branch, by git_op's pull argument
const PULLS: Record<string, string> = { "": "fast-forward if possible", "ff-only": "fast-forward only", rebase: "rebase" };

export let tabs: Tab[] = [];
export let active = 0;
export let repo = "";
export let commits: Commit[] = [];
export let status: Status | null = null;
export let refs: Refs = { refs: [], stashes: [], remotes: [], worktrees: [], submodules: [], superproject: "", repoTop: "", lfs: false, lfsProblem: "" };
// the picked graph rows ("WIP" or hashes), where a Shift range starts, whether it is one, or the stash shown instead
export const selection = { hashes: ["WIP"], anchor: "", isRange: false, stash: null as Stash | null };
// the merge, rebase... in progress, and the step whose message the commit box holds
export let opInfo: OpInfo | null = null;
let opStep = "";
let graphKey = "", sideKey = "", panelKey = "";
export const headHash = () => commits.find(isHead)?.hash ?? "";

export const run = <T>(cmd: string, args: Record<string, unknown> = {}) => invoke<T>(cmd, { repo, ...args });
export const DEFAULT_EDITOR = "code -g {file}:{line}";
/** Open the working tree's `path` at `line` with the Settings tab's editor command. */
// an emptied command means the desktop's default app
export const openInEditor = (path: string, line: number) => run("open_in_editor", { path, line, editor: store("editor") ?? DEFAULT_EDITOR });

// a commit never changes: the last answer per command about one is kept
const fixed = new Map<string, { key: string; data: Promise<unknown> }>();
export function runFixed<T>(cmd: string, args: Record<string, unknown>) {
  const key = JSON.stringify([repo, args]);
  const known = fixed.get(cmd);
  if (known?.key === key) return known.data as Promise<T>;
  const data = run<T>(cmd, args);
  fixed.set(cmd, { key, data });
  data.catch(() => fixed.get(cmd)?.data === data && fixed.delete(cmd));
  return data;
}

/** Run git op `name`; a pair passes a second argument (new name, start point, remote branch). */
export async function gitOp(name: string, arg: string | [string, string] = "", record = true) {
  const [arg1, arg2] = Array.isArray(arg) ? arg : [arg, ""];
  const tab = tabs[active], branch = status?.branch ?? "", head = headHash();
  say(`${name}…`);
  document.body.classList.add("busy");
  let ok = true;
  try {
    const out = await run<string>("git_op", { op: name, arg: arg1, arg2 });
    // git's own last word, not pre-commit's notes about stashing
    const last = out.trim().split("\n").filter((l) => !hookLine(l) && !/^\[(INFO|WARNING)\]/.test(l)).pop()?.trim() || `${name}: done`;
    say(last);
    toastHooks(out);
    // what the server says on push (pull request links, warnings) deserves more than the status bar
    const remote = out.split("\n").flatMap((l) => (l.startsWith("remote:") && l.slice(7).trim() ? [l.slice(7).trim()] : []));
    const upstream = findRef(`refs/heads/${branch}`)?.upstream ?? "";
    const done = DONE[name]?.(arg1, arg2, branch, upstream);
    // git said nothing: the title is all there is
    if (done) toast(done, remote.length ? remote.join("\n") : out.trim() ? last : "", "info");
    else if (remote.length) toast("Message from the remote", remote.join("\n"), "info");
  } catch (e) {
    const msg = String(e);
    const what = name === "push-upstream" ? "Push" : name === "push-force" ? "Force push" : name === "rebase-interactive" ? "Interactive rebase" : name[0].toUpperCase() + name.slice(1).replace(/-/g, " ");
    const onBranch = /^(push|pull)/.test(name) && branch ? `: ${branch}` : "";
    // stopping on conflicts is no failure: the WIP panel takes over
    const conflicts = msg.split("\n").filter((l) => l.startsWith("CONFLICT"));
    // rerere's replays: "Resolved 'f' using previous resolution."
    const reused = msg.split("\n").filter((l) => l.includes("using previous resolution"));
    if (conflicts.length) {
      toast(`${what} stopped on conflicts`, [...conflicts, ...reused].join("\n"), "info");
      if (!name.startsWith("stash")) rerereTip();
      if (tab === tabs[active]) {
        selection.stash = null;
        selection.hashes = [(selection.anchor = "WIP")];
      }
    } else if (name === "push" && msg.includes("(non-fast-forward)")) forcePush(branch, status?.behind ?? 0);
    else toast(`${what} failed${onBranch}`, msg + hint(msg), "err");
    say(`${what} ${conflicts.length ? "stopped on conflicts" : "failed"}`);
    ok = false;
  }
  document.body.classList.remove("busy");
  await refresh();
  if (ok && NET_OPS.has(name)) loadRemoteTags();
  if (ok && record && UNDOABLE.has(name) && tab === tabs[active]) {
    const what = MAKE_COMMIT.has(name) ? `"${commits.find(isHead)?.subject ?? ""}"` : name === "pull" ? "" : short(arg1);
    const step: UndoStep = { op: name, what, branch: [branch, status?.branch ?? ""], head: [head, headHash()] };
    if (step.head.every(Boolean) && (step.head[0] !== step.head[1] || step.branch[0] !== step.branch[1])) recordUndo(tab, step);
  }
  return ok;
}

// pre-commit's report, "name.....Passed": proof the hooks ran, worth a toast
const hookLine = (l: string) => l.match(/^(.+?)\.{3,}(?:\(.*\))?(Passed|Skipped)$/);

function toastHooks(out: string) {
  const hooks = out.split("\n").flatMap((l) => hookLine(l) ?? []);
  if (!hooks.length) return;
  const passed = hooks.filter((m) => m[2] === "Passed").length;
  const lines = hooks.map((m) => `${m[2] === "Passed" ? "✓" : "–"} ${m[1]}${m[2] === "Passed" ? "" : " (skipped)"}`);
  toast(`Hooks passed: ${passed} ran, ${hooks.length - passed} skipped`, lines.join("\n"), "info");
}

/** The branch and its upstream have diverged: a banner offers to overwrite the upstream, if it holds nothing unseen. */
function forcePush(branch: string, behind: number) {
  const upstream = findRef(`refs/heads/${branch}`)?.upstream ?? "its upstream";
  const lost = behind ? plural(behind, "commit") : "commits";
  showBanner(
    h("span", { textContent: `Push rejected: ${upstream} has ${lost} that ${branch} has not, which a force push drops.` }),
    // --force-if-includes: what a background fetch brought in is never overwritten unseen
    h("button", { className: "primary", textContent: "Force push", onclick: () => (hideBanner(), gitOp("push-force")) }),
  );
}

const stepText = (s: UndoStep) => (s.what ? `${s.op} ${s.what}` : s.op);

/** Undo's (or Redo's) steps, newest first: picking one walks back through it. */
export function undoMenu(e: MouseEvent, back: boolean) {
  const t = tabs[active];
  // ponytail: the 20 newest of the 50 kept, a longer menu runs off the window
  const steps = (back ? t.undo : t.redo).slice(-20).reverse();
  popup(
    e,
    steps.map((s, i): MenuItem => [`${back ? "Undo" : "Redo"} ${stepText(s)}`, async () => {
      for (let k = 0; k <= i && tabs[active] === t && (await undoRedo(back)); k++);
    }]),
  );
}

/** A step for Undo; the oldest go past 50, a discard's holding its file twice. */
export function recordUndo(t: Tab, step: UndoStep) {
  t.undo.push(step);
  if (t.undo.length > 50) t.undo.shift();
  t.redo = [];
  renderToolbar();
}

export const pull = () => gitOp("pull", store("pull-mode") ?? "");

/** The Pull modes under the toolbar's caret: picking one makes it the default and pulls. */
export function pullMenu(e: MouseEvent) {
  e.stopPropagation();
  const mode = store("pull-mode") ?? "", r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  showMenu(
    [
      ...Object.entries(PULLS).map(([k, label]): MenuItem => [`Pull, ${label}${k === mode ? "  ✓" : ""}`, () => (store("pull-mode", k), paintPull(), pull())]),
      // the files a clone or checkout left as pointers
      ...(refs.lfs ? ([null, ["Pull LFS files", () => gitOp("lfs-pull")], ["Prune LFS files", pruneLfs]] as MenuItem[]) : []),
    ],
    r.left,
    r.bottom,
  );
}

/** git-lfs keeps what is checked out, recent or not pushed yet: the rest can download again. */
const pruneLfs = () => ask("Delete the local copies of old LFS file versions? The checked out, recent and unpushed ones stay; the others download again when needed.", "Prune").then((ok) => ok && gitOp("lfs-prune"));

export const paintPull = () => ($("pull").title = `Pull, ${PULLS[store("pull-mode") ?? ""]}`);

/** Push; a branch without upstream first asks where to, in a banner. */
export function push() {
  const branch = status?.branch ?? "";
  if (!branch || findRef(`refs/heads/${branch}`)?.upstream) return gitOp("push");
  if (!refs.remotes.length) return toast(`Push failed: ${branch}`, "This repository has no remote.", "err");
  const remote = h("select", {}, ...refs.remotes.map((r) => h("option", { value: r, textContent: r })));
  remote.value = refs.remotes.includes("origin") ? "origin" : refs.remotes[0];
  const name = h("input", { value: branch, spellcheck: false });
  const submit = () => {
    if (!name.value.trim()) return;
    hideBanner();
    gitOp("push-upstream", [remote.value, name.value.trim()]);
  };
  name.onkeydown = (e) => {
    if (e.key === "Enter") submit();
  };
  showBanner(
    h("span", { textContent: `Where should "${branch}" push to and pull from?` }),
    remote,
    h("span", { textContent: "/" }),
    name,
    h("button", { className: "primary", textContent: "Push", onclick: submit }),
  );
  name.select();
}

/** Undo (or redo) the last HEAD move krill made, if nothing moved HEAD since. */
export async function undoRedo(back: boolean): Promise<boolean> {
  const t = tabs[active];
  // a tab still loading has no HEAD to compare yet: its steps would look stale
  if (!status) return false;
  const step = (back ? t.undo : t.redo).pop();
  if (!step) return false;
  const [from, to] = back ? [1, 0] : [0, 1];
  if (headHash() !== step.head[from] || (status?.branch ?? "") !== step.branch[from]) {
    t.undo = [];
    t.redo = [];
    renderToolbar();
    return void say(`HEAD moved outside krill, nothing to ${back ? "undo" : "redo"}`, true), false;
  }
  let ok;
  if (step.file) {
    const [path, ...text] = step.file, r = repo;
    const now = await run<Blob>("blob", { at: "WORKTREE", path });
    // left for another tab meanwhile: the step waits for its own
    if (repo !== r) return (back ? t.undo : t.redo).push(step), false;
    if ((now.exists ? now.text : null) !== text[from]) {
      renderToolbar();
      return void say(`${path} changed since, nothing to ${back ? "undo" : "redo"}`, true), false;
    }
    const write = text[to] === null ? run("delete_file", { path }) : run("write_file", { path, text: text[to] });
    ok = await write.then(() => true, (e) => (say(String(e), true), false));
    await refresh();
  } else
    ok =
      step.branch[0] !== step.branch[1]
        ? await gitOp("checkout", step.branch[to] || step.head[to], false)
        : await gitOp(KEEP_INDEX.has(step.op) ? "reset-soft" : "reset-keep", step.head[to], false);
  (ok === back ? t.redo : t.undo).push(step);
  renderToolbar();
  return ok;
}

let refreshing: Promise<void> | null = null;
let refreshAgain: Promise<void> | null = null;
/** Reload and repaint the tab; one run at a time so an older snapshot never lands last, callers meanwhile share the next run. */
export function refresh(): Promise<void> {
  if (!refreshing) return (refreshing = reload().catch((e) => say(String(e), true)).finally(() => (refreshing = null)));
  return (refreshAgain ??= refreshing.then(() => ((refreshAgain = null), refresh())));
}

/** Refresh, redrawing the graph and the sidebar even when their data is the same: what they hide changed. */
export function redraw() {
  graphKey = sideKey = "";
  return refresh();
}

async function reload() {
  const r = repo;
  if (!r) return;
  try {
    const [s, log, rf] = await Promise.all([run<Status>("status"), run<Commit[]>("log", { limit: tabs[active].limit, ...graphFilter() }), run<Refs>("refs")]);
    const info = s.state ? await run<OpInfo>("op_info").catch(() => null) : null;
    if (r !== repo) return;
    status = s;
    refs = rf;
    if (rf.lfs && rf.lfsProblem) warnOnce(`lfs:${r}`, `${basename(r)} uses Git LFS`, LFS_PROBLEMS[rf.lfsProblem], "err");
    opInfo = info;
    const landed = landing;
    if (landed) land();
    closeResolvedMerge();
    const step = opInfo ? JSON.stringify([opInfo.state, opInfo.step, opInfo.message]) : "";
    if (step !== opStep) {
      if (opStep || step) setMsg(opInfo?.message ?? "");
      opStep = step;
    }
    // the WIP row comes and goes with changes or an operation; its counts alone repaint just that row
    // the worktrees too: a branch label shows whether one has it checked out
    const key = JSON.stringify([log.map((c) => [c.hash, c.refs]), !!(s.staged.length || s.unstaged.length || opInfo), rf.stashes.map((x) => x.hash), rf.worktrees.map((w) => [w.branch, w.prunable])]);
    if (key === graphKey) paintWipRow();
    else {
      graphKey = key;
      commits = log;
      selection.hashes = selection.hashes.filter((x) => x === "WIP" || commits.some((c) => c.hash === x));
      if (!selection.hashes.length && !selection.stash) selection.hashes = ["WIP"];
      // nothing to commit: open on HEAD, not on an empty WIP panel
      if (selection.hashes[0] === "WIP" && !s.staged.length && !s.unstaged.length && !opInfo && headHash()) selection.hashes = [(selection.anchor = headHash())];
      renderGraph(landed?.scroll);
    }
    if (selection.stash && !rf.stashes.some((x) => x.hash === selection.stash!.hash)) selection.stash = null;
    const rk = JSON.stringify([rf, s.branch]);
    if (rk !== sideKey) {
      sideKey = rk;
      renderSide();
    }
    renderToolbar();
    // a picked commit's panel changes only with the pick, or with HEAD for its Edit button
    const panel = JSON.stringify([selection.hashes, selection.stash?.hash, headHash()]), row = openRow();
    if ((selection.hashes[0] === "WIP" && !selection.stash) || panel !== panelKey) {
      panelKey = panel;
      await renderPanel();
    }
    if (diffFile) await reloadDiff(row);
  } catch (e) {
    if (r !== repo) return;
    // the folder went away under the tab, like a removed worktree: close it rather than fail on every refresh
    if (!(await isRepo(r))) {
      if (r !== repo) return;
      toast(`Closed ${tabName(tabs[active])}`, `${r} no longer exists. Removed from the recent list.`, "info");
      forgetRecent(r);
      // not awaited: closing switches tabs, whose refresh waits for this one to end
      void closeTab(active);
      return;
    }
    say(String(e), true);
  }
}

export const isRepo = (path: string) => invoke("repo_root", { path }).then(() => true, () => false);

function renderToolbar() {
  if (!status) return;
  $("branch").textContent = $("branch").title = status.branch || "detached HEAD";
  $("repo-ico").innerHTML = svg(refs.superproject ? ICONS.submodule : tabs[active].worktree ? ICONS.worktree : ICONS.repo);
  $("branch-ico").innerHTML = svg(ICONS.branch);
  $("behind").textContent = status.behind ? String(status.behind) : "";
  $("ahead").textContent = status.ahead ? String(status.ahead) : "";
  $("opstate").hidden = !status.state;
  const conflicts = conflictCount() > 0;
  $("opstate").classList.toggle("bad", conflicts);
  $("opstate").replaceChildren(h("b", { textContent: status.state }), ` in progress${conflicts ? " (conflicts detected)" : ""}`);
  const { undo, redo } = tabs[active];
  const u = $("undo") as HTMLButtonElement, r = $("redo") as HTMLButtonElement;
  u.disabled = !undo.length;
  r.disabled = !redo.length;
  u.title = undo.length ? `Undo ${stepText(undo[undo.length - 1])} (Ctrl+Z)` : "Nothing to undo";
  r.title = redo.length ? `Redo ${stepText(redo[redo.length - 1])} (Ctrl+Shift+Z)` : "Nothing to redo";
}

/* tabs and home */

const aliases = (): Record<string, string> => JSON.parse(store("aliases") ?? "{}");
/** The header's repository name and the window title; a linked worktree names its main repository first. */
export function paintRepoName() {
  const t = tabs[active], name = tabName(t), main = refs.worktrees[0];
  $("repo-name").title = repo;
  // a worktree or a submodule: its repository's name leads back, so does the ×
  if (t.parent) {
    const back = `Back to ${repoLabel(t.parent)} (Esc, Alt+←)`;
    $("repo-name").replaceChildren(
      // in the colour of its tab badge: the repository this tab belongs to
      h("span", { className: "back", textContent: repoLabel(t.parent), title: back, onclick: stepBack, style: `color: ${COLORS[colorIndex(t.parent)]}` }),
      ` › ${childLabel(t)}`,
      h("button", { className: "icon sub-close", title: back, innerHTML: svg(ICONS.close), onclick: stepBack }),
    );
  } else $("repo-name").textContent = !main || main === thisWorktree() ? name : `${basename(main.path)} › ${name}`;
  getCurrentWindow().setTitle(repo ? `Git Krill · ${name}` : "Git Krill");
}

const repoLabel = (path: string) => aliases()[path] ?? basename(path);
/** "beetle › logger"; a worktree folder named after its repository, like harma-belukha-fix, shows as fix. */
function childLabel(t: Tab) {
  const name = repoLabel(t.repo), lead = `${repoLabel(t.parent)}-`;
  return name.startsWith(lead) && name.length > lead.length ? name.slice(lead.length) : name;
}
export const tabName = (t: Tab) => (t.settings ? "Settings" : !t.repo ? "Home" : t.parent ? `${repoLabel(t.parent)} › ${childLabel(t)}` : repoLabel(t.repo));
// closed this session, for Ctrl+Shift+T
const closedTabs: string[] = [];
// a submodule shown in its parent's tab reopens as that parent
const closedRepo = (t: Tab) => (t.worktree ? t.repo : t.parent || t.repo);

/** Reopen the last run's tabs, then the repository krill was started on; the splash stays until `ready` too. */
export async function restoreTabs(ready: Promise<unknown>) {
  // a submodule opened in its parent's tab is saved as [parent, submodule]
  tabs = (JSON.parse(store("tabs") ?? "[]") as (string | string[])[]).map((x) => (Array.isArray(x) ? newTab(x[1], x[0]) : x === SETTINGS ? settingsTab() : newTab(x)));
  if (!tabs.length) tabs.push(newTab(""));
  active = Math.min(Number(store("active-tab")) || 0, tabs.length - 1);
  const arg = await invoke<string>("initial_repo");
  try {
    if (!arg || !(await openRepo(arg))) await switchTab(active, false);
  } finally {
    await ready;
    // the first view is drawn: the splash fades away
    requestAnimationFrame(() => $("splash").classList.add("gone"));
    setTimeout(() => ($("splash").hidden = true), 400);
  }
}

// the Settings tab in the saved list: no folder is named so
const SETTINGS = ":settings";
const settingsTab = () => Object.assign(newTab(""), { settings: true });

function saveTabs() {
  store("tabs", JSON.stringify(tabs.map((t) => (t.settings ? SETTINGS : t.parent ? [t.parent, t.repo] : t.repo))));
  store("active-tab", String(active));
}

export function newTab(repo: string, parent = ""): Tab {
  const t: Tab = { repo, parent, selected: ["WIP"], msg: "", scroll: 0, undo: [], redo: [], worktree: false, limit: LOG_LIMIT, settings: false };
  // a linked worktree leads back to its main checkout, however it was opened
  if (repo)
    invoke<string>("worktree_main", { repo }).then((main) => {
      if (!main) return;
      Object.assign(t, { worktree: true, parent: main });
      renderTabs();
      if (t === tabs[active]) paintRepoName();
    });
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
        // a repo's initial on a colour of its own, so tabs tell apart at a glance
        // a worktree or a submodule wears its repository's badge
        t.repo
          ? h("span", { className: "tab-badge", textContent: tabName(t)[0]?.toUpperCase() ?? "", style: `--c: ${COLORS[colorIndex(t.parent || t.repo)]}` })
          : ico(t.settings ? ICONS.settings : ICONS.home),
        h("span", { className: "tab-name", textContent: tabName(t) }),
        h("button", { className: "x", textContent: "×", title: "Close (Ctrl+W)", onclick: (e: Event) => (e.stopPropagation(), closeTab(i)) }),
      ),
    ),
  );
  $("tablist").children[active]?.scrollIntoView({ block: "nearest", inline: "nearest" });
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

/** Whether the open diff's and merge's unsaved edits may go, asking first; the merge closes. */
export const dropEdits = async () => (await confirmDrop()) && (await closeMerge(true));

/** What the open tab shows, kept in it for its return; a tab left before its graph came keeps its old scroll and draft. */
export const keepTab = () => Object.assign(tabs[active], { selected: selection.hashes, msg: status ? getMsg() : tabs[active].msg, scroll: commits.length ? $("graph").scrollTop : tabs[active].scroll });

export async function switchTab(i: number, save = true) {
  if (save && !(await dropEdits())) return;
  if (save) keepTab();
  closeHistory();
  // its Push is for the tab it was asked in
  hideBanner();
  active = i;
  const t = tabs[active];
  repo = t.repo;
  selection.hashes = t.selected;
  selection.anchor = selection.hashes[0];
  selection.isRange = false;
  selection.stash = null;
  commits = [];
  status = null;
  opInfo = null;
  graphKey = sideKey = panelKey = opStep = "";
  saveTabs();
  renderTabs();
  showTerm(false);
  // the last tab stays on screen until this one's data is in, then it all changes in one frame
  landing = t;
  if (!repo) return land(), renderRecent();
  await refresh();
  if (tabs[active] !== t) return;
  // its refresh failed: show it empty rather than the last tab
  if (landing === t) land();
  autoFetch();
}

let landing: Tab | null = null;

/** Clear the last tab's view for the one switched to. */
function land() {
  const t = landing!;
  landing = null;
  setMsg(t.msg);
  resetGraph();
  $("sidebar").replaceChildren();
  document.body.classList.toggle("home", !repo);
  $("home").hidden = !!repo || t.settings;
  $("settings").hidden = !t.settings;
  if (t.settings) renderSettings();
  paintRepoName();
}

export async function closeTab(i: number) {
  if (i === active && !(await dropEdits())) return;
  dropTerm(tabs[i]);
  if (tabs[i].repo) closedTabs.push(closedRepo(tabs[i]));
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
    if (t.repo) closedTabs.push(closedRepo(t));
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
  if (t.repo) items.push(["Rename tab", () => renameTab(i)]);
  return [...items, reopenItem()];
}

const reopenItem = (): MenuItem => ["Reopen closed tab", closedTabs.length ? reopenTab : null];
export const newTabMenu = (): MenuItem[] => [["New tab", addTab], reopenItem()];

/** Rename a tab in place: Enter or leaving the field keeps it, Esc cancels, empty resets. */
function renameTab(i: number) {
  const t = tabs[i];
  let done = false;
  const box = h("input", { className: "tab-alias", value: repoLabel(t.repo), spellcheck: false, onclick: (e: Event) => e.stopPropagation() });
  const finish = (keep: boolean) => {
    if (done) return;
    done = true;
    const all = aliases(), name = box.value.trim();
    if (keep && name && name !== basename(t.repo)) all[t.repo] = name;
    else if (keep) delete all[t.repo];
    store("aliases", JSON.stringify(all));
    renderTabs();
    if (t === tabs[active]) paintRepoName();
  };
  box.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter" || e.key === "Escape") finish(e.key === "Enter");
  };
  box.onblur = () => finish(true);
  ($("tablist").children[i] as HTMLElement).replaceChildren(box);
  box.select();
}

export function reopenTab() {
  const r = closedTabs.pop();
  if (r) openRepo(r);
}

export function renderTabHits() {
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
              h("button", { textContent: "×", title: "Close", onclick: (e: Event) => (e.stopPropagation(), closeTab(i).then(renderTabHits)) }),
            ),
          ],
    ),
  );
}

export function addTab() {
  tabs.push(newTab(""));
  switchTab(tabs.length - 1);
}

/** The Settings tab, opened once. */
export function openSettings() {
  const i = tabs.findIndex((t) => t.settings);
  if (i >= 0) return switchTab(i);
  tabs.push(settingsTab());
  switchTab(tabs.length - 1);
}

/** Open `path` in its existing tab, the current Home tab, or a new tab. */
export async function openRepo(path: string) {
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
    const home = tabs[active].repo || tabs[active].settings ? -1 : active;
    await switchTab(i);
    if (home >= 0) closeTab(home);
  } else if (tabs[active].repo || tabs[active].settings) {
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

/** Clone dialog: where to (typed or browsed, remembered), the URL, then the folder name, from the URL until edited. */
export function cloneDialog() {
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
  const submit = async () => {
    if (go.disabled) return;
    go.disabled = true;
    go.textContent = "Cloning…";
    try {
      const path = await invoke<string>("clone", { parent: parent.value.trim(), url: url.value.trim(), name: name.value.trim() });
      store("clone-dir", parent.value.trim());
      hideDialog();
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
  showDialog(
    "Clone a repository",
    [h("label", { textContent: "Where to clone to" }), h("div", { className: "dlg-row" }, parent, h("button", { textContent: "Browse…", onclick: browse })), h("label", { textContent: "URL" }), url, fullLabel, full],
    [go],
    null,
    "clone-dlg",
  );
  paint();
  url.focus();
}

// ssh asking for a key's passphrase, or git for https credentials, while krill runs them
listen<string>("askpass", ({ payload: prompt }) => {
  const secret = /passphrase|password/i.test(prompt);
  const reply = (answer: string | null) => invoke("askpass_reply", { answer });
  dialog(/passphrase/i.test(prompt) ? "SSH key passphrase" : "Sign in", [[prompt, "", secret ? "password" : "text"]], "OK", ([v]) => reply(v), [], () => reply(null));
});

// remotes whose branches all leave the graph, new ones included
export const hiddenRemotes = (): string[] => JSON.parse(store(`hidden-remotes:${repo}`) ?? "[]");
// refs and stash hashes flipped one by one: hidden, or for a hidden remote's branch, shown again
const flippedRefs = (): string[] => JSON.parse(store(`hidden-refs:${repo}`) ?? "[]");
// one per repository: its worktrees share the main checkout's, a submodule opened in its tab the parent's
export const foldsKey = () => `sidebar-folds:${tabs[active]?.parent || refs.worktrees[0]?.path || repo}`;
export const sideFolds = (): Record<string, boolean> => JSON.parse(store(foldsKey()) ?? "{}");
const remoteOf = (ref: string) => (ref.startsWith("refs/remotes/") ? ref.slice("refs/remotes/".length).split("/")[0] : "");

// what the graph leaves out, as of its last paint: refs, stash hashes and hidden remotes' names
export let hiddenSet = new Set<string>();
export function updateHidden() {
  const remotes = hiddenRemotes(), flipped = new Set(flippedRefs());
  hiddenSet = new Set([...remotes, ...[...flipped].filter((k) => !remoteOf(k))]);
  for (const r of refs.refs) if (remoteOf(r.name) && remotes.includes(remoteOf(r.name)) !== flipped.has(r.name)) hiddenSet.add(r.name);
}

/** The log's ref patterns to leave out, and the branches of hidden remotes shown again. */
function graphFilter() {
  const remotes = hiddenRemotes(), flipped = flippedRefs().filter((k) => k.startsWith("refs/"));
  const ofHidden = (k: string) => remotes.includes(remoteOf(k));
  return { hide: [...remotes.map((r) => `refs/remotes/${r}/*`), ...flipped.filter((k) => !ofHidden(k))], show: flipped.filter((k) => ofHidden(k) && findRef(k)) };
}

/** Show or hide `key` in the menus that offer it. */
export const hideItem = (key: string): MenuItem => [hiddenSet.has(key) ? "Show" : "Hide", () => toggleHidden(key)];

export function toggleHidden(key: string) {
  const list = flippedRefs();
  store(`hidden-refs:${repo}`, JSON.stringify(list.includes(key) ? list.filter((x) => x !== key) : [...list, key]));
  redraw();
}

/** Hide or show all of `name`'s branches: the ones flipped one by one follow it again. */
export function toggleRemote(name: string) {
  const remotes = hiddenRemotes();
  store(`hidden-remotes:${repo}`, JSON.stringify(remotes.includes(name) ? remotes.filter((r) => r !== name) : [...remotes, name]));
  store(`hidden-refs:${repo}`, JSON.stringify(flippedRefs().filter((k) => remoteOf(k) !== name)));
  redraw();
}

/** A row that is no commit of the log (WIP, a stash, uncommitted lines), shaped like one. */
export const fakeCommit = (hash: string, parents: string[], subject: string): Commit => ({ hash, parents, author: "", time: 0, refs: [], subject, body: "" });
export const findRef = (name: string) => refs.refs.find((r) => r.name === name);
// this checkout's entry, else the main one
export const thisWorktree = () => refs.worktrees.find((w) => w.path === repo) ?? refs.worktrees[0];

export const isHead = (c: Commit) => c.refs.some((r) => r === "HEAD" || r.startsWith("HEAD -> "));
// the tags on each remote, per repository, asked after each fetch and push: a remote left out is unknown
export const remoteTags = new Map<string, Record<string, string[]>>();
/** Ask the remotes which tags they have; the labels repaint when that changed. */
function loadRemoteTags() {
  const r = repo;
  run<Record<string, string[]>>("remote_tags").then(
    (t) => {
      const was = JSON.stringify(remoteTags.get(r));
      remoteTags.set(r, t);
      if (r === repo && JSON.stringify(t) !== was) redraw();
    },
    () => {},
  );
}
// when each repository was last fetched in the background
const fetchedAt = new Map<string, number>();
// repositories whose background fetch was told to need a passphrase or password, once a run
const toldAuth = new Set<string>();
// the Settings tab's background fetch: on unless turned off, every few minutes
export const fetchMinutes = () => Number(store("fetch-minutes")) || 5;
/** A quiet fetch of the open repository, `gap` ms after its last at the soonest: ahead/behind and remote branches stay fresh; failures (offline) stay silent. */
export function autoFetch(gap = 60_000) {
  const r = repo;
  // timed from its start, a few seconds early allowed: the minute tick would otherwise just miss it
  if (!r || store("auto-fetch") === "off" || Date.now() - (fetchedAt.get(r) ?? 0) < gap - 5_000 || document.body.classList.contains("busy")) return;
  const started = Date.now();
  // never twice at once: on a dead network one can hang for minutes
  fetchedAt.set(r, Infinity);
  run<string>("git_op", { op: "auto-fetch", arg: "" }).then(
    (out) => {
      fetchedAt.set(r, started);
      if (r === repo) loadRemoteTags();
      // with several remotes git names each one even when nothing came
      if (r === repo && out.split("\n").some((l) => l.trim() && !l.startsWith("Fetching "))) refresh();
    },
    (e) => {
      fetchedAt.set(r, started);
      if (!String(e).includes("krill: needs a passphrase or password") || toldAuth.has(r)) return;
      toldAuth.add(r);
      toast(`Auto-fetch skipped: ${aliases()[r] ?? basename(r)}`, "Its remote needs a passphrase or password, which a background fetch cannot ask for. Use Fetch to enter it.", "info");
    },
  );
}
export const openPicked = async () => {
  const p = await pickDir("Open repository");
  if (p) await openRepo(p);
};
