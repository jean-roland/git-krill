// The open repository: shared state, git ops, refresh, undo, pull/push, tabs and the home screen.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { repoName } from "./core.js";
import { $, COLORS, ICONS, MenuItem, basename, colorIndex, dialog, h, hideBanner, hideDialog, hint, ico, input, pickDir, popup, say, showBanner, showDialog, showMenu, store, svg, toast } from "./ui";
import { closeHistory, closeMerge, closeResolvedMerge, confirmDrop, diffFile, openRow, reloadDiff } from "./diff";
import { conflictCount, getMsg, renderPanel, setMsg } from "./panel";
import { paintWipRow, renderGraph, renderSide, resetGraph } from "./graph";
import { dropTerm, showTerm } from "./terminal";

export type Change = { path: string; old: string | null; code: string; conflict?: string };
type OpInfo = { state: string; current: string; incoming: string; currentCommit: string; incomingCommit: string; step: string; message: string };
export type Commit = { hash: string; parents: string[]; author: string; time: number; refs: string[]; subject: string; body: string };
export type Status = { branch: string; state: string; ahead: number | null; behind: number | null; staged: Change[]; unstaged: Change[] };
type Ref = { name: string; hash: string; upstream: string; track: string };
export type Stash = { name: string; hash: string; parents: string[]; subject: string };
export type Worktree = { path: string; head: string; branch: string; locked: boolean; prunable: boolean };
type Refs = { refs: Ref[]; stashes: Stash[]; remotes: string[]; worktrees: Worktree[] };
// large: too big to load unasked, its size in bytes
export type Blob = { text: string; exists: boolean; binary: boolean; large: number | null };
// file: a discard, the work tree text before and after (null: no file)
type UndoStep = { op: string; branch: [string, string]; head: [string, string]; file?: [string, string | null, string | null] };
// limit: how many commits the graph loads, raised by "Load more"
export type Tab = { repo: string; selected: string[]; msg: string; scroll: number; undo: UndoStep[]; redo: UndoStep[]; worktree: boolean; limit: number };
export const LOG_LIMIT = 3000;
// ops that move HEAD, walked back with a reset or a checkout
const UNDOABLE = new Set([
  "commit", "amend", "reword", "checkout", "merge", "rebase", "rebase-interactive", "cherry-pick", "pull",
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
  "branch-delete": (name) => `Deleted branch ${name}`,
  "branch-force-delete": (name) => `Deleted branch ${name}`,
  "worktree-remove": (path) => `Removed worktree ${basename(path)}`,
  "worktree-force-remove": (path) => `Removed worktree ${basename(path)}`,
  "worktree-prune": () => "Pruned the worktrees whose folder is gone",
};
// how Pull reconciles a diverged branch, by git_op's pull argument
const PULLS: Record<string, string> = { "": "fast-forward if possible", "ff-only": "fast-forward only", rebase: "rebase" };

export let tabs: Tab[] = [];
export let active = 0;
export let repo = "";
export let commits: Commit[] = [];
export let status: Status | null = null;
export let refs: Refs = { refs: [], stashes: [], remotes: [], worktrees: [] };
// the picked graph rows ("WIP" or hashes), where a Shift range starts, whether it is one, or the stash shown instead
export const selection = { hashes: ["WIP"], anchor: "", isRange: false, stash: null as Stash | null };
// the merge, rebase... in progress, and the step whose message the commit box holds
export let opInfo: OpInfo | null = null;
let opStep = "";
let graphKey = "", sideKey = "", panelKey = "";
export const headHash = () => commits.find(isHead)?.hash ?? "";

export const run = <T>(cmd: string, args: Record<string, unknown> = {}) => invoke<T>(cmd, { repo, ...args });

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
    const what = name === "push-upstream" ? "Push" : name === "rebase-interactive" ? "Interactive rebase" : name[0].toUpperCase() + name.slice(1).replace(/-/g, " ");
    const onBranch = /^(push|pull)/.test(name) && branch ? `: ${branch}` : "";
    // stopping on conflicts is no failure: the WIP panel takes over
    const conflicts = msg.split("\n").filter((l) => l.startsWith("CONFLICT"));
    if (conflicts.length) {
      toast(`${what} stopped on conflicts`, conflicts.join("\n"), "info");
      if (tab === tabs[active]) {
        selection.stash = null;
        selection.hashes = [(selection.anchor = "WIP")];
      }
    } else toast(`${what} failed${onBranch}`, msg + hint(msg), "err");
    say(`${what} ${conflicts.length ? "stopped on conflicts" : "failed"}`);
    ok = false;
  }
  document.body.classList.remove("busy");
  await refresh();
  if (ok && record && UNDOABLE.has(name) && tab === tabs[active]) {
    const step: UndoStep = { op: name, branch: [branch, status?.branch ?? ""], head: [head, headHash()] };
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
    Object.entries(PULLS).map(([k, label]): MenuItem => [`Pull, ${label}${k === mode ? "  ✓" : ""}`, () => (store("pull-mode", k), paintPull(), pull())]),
    r.left,
    r.bottom,
  );
}

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
export async function undoRedo(back: boolean) {
  const t = tabs[active];
  const step = (back ? t.undo : t.redo).pop();
  if (!step) return;
  const [from, to] = back ? [1, 0] : [0, 1];
  if (headHash() !== step.head[from] || (status?.branch ?? "") !== step.branch[from]) {
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
        ? await gitOp("checkout", step.branch[to] || step.head[to], false)
        : await gitOp(KEEP_INDEX.has(step.op) ? "reset-soft" : "reset-keep", step.head[to], false);
  (ok === back ? t.redo : t.undo).push(step);
  renderToolbar();
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
    const key = JSON.stringify([log.map((c) => [c.hash, c.refs]), !!(s.staged.length || s.unstaged.length || opInfo), rf.stashes.map((x) => x.hash)]);
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
  $("repo-ico").innerHTML = svg(tabs[active].worktree ? ICONS.worktree : ICONS.repo);
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
  u.title = undo.length ? `Undo ${undo[undo.length - 1].op} (Ctrl+Z)` : "Nothing to undo";
  r.title = redo.length ? `Redo ${redo[redo.length - 1].op} (Ctrl+Shift+Z)` : "Nothing to redo";
}

/* tabs and home */

const aliases = (): Record<string, string> => JSON.parse(store("aliases") ?? "{}");
/** The header's repository name and the window title; a linked worktree names its main repository first. */
export function paintRepoName() {
  const name = tabName(tabs[active]), main = refs.worktrees[0];
  $("repo-name").textContent = !main || main === thisWorktree() ? name : `${basename(main.path)} › ${name}`;
  $("repo-name").title = repo;
  getCurrentWindow().setTitle(repo ? `Git Krill · ${name}` : "Git Krill");
}

export const tabName = (t: Tab) => (t.repo ? (aliases()[t.repo] ?? basename(t.repo)) : "Home");
// closed this session, for Ctrl+Shift+T
const closedTabs: string[] = [];

/** Reopen the last run's tabs, then the repository krill was started on. */
export async function restoreTabs() {
  tabs = (JSON.parse(store("tabs") ?? "[]") as string[]).map(newTab);
  if (!tabs.length) tabs.push(newTab(""));
  active = Math.min(Number(store("active-tab")) || 0, tabs.length - 1);
  const arg = await invoke<string>("initial_repo");
  const first = arg || tabs[active].repo;
  $("splash-what").textContent = `${first ? (aliases()[first] ?? basename(first)) : "Home"} is loading…`;
  try {
    if (!arg || !(await openRepo(arg))) await switchTab(active, false);
  } finally {
    // the first view is drawn: the splash fades away
    requestAnimationFrame(() => $("splash").classList.add("gone"));
    setTimeout(() => ($("splash").hidden = true), 400);
  }
}

function saveTabs() {
  store("tabs", JSON.stringify(tabs.map((t) => t.repo)));
  store("active-tab", String(active));
}

export function newTab(repo: string): Tab {
  const t: Tab = { repo, selected: ["WIP"], msg: "", scroll: 0, undo: [], redo: [], worktree: false, limit: LOG_LIMIT };
  // a linked worktree's .git is a file
  if (repo) invoke<boolean>("is_linked_worktree", { repo }).then((w) => w && ((t.worktree = true), renderTabs()));
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
        t.repo && !t.worktree
          ? h("span", { className: "tab-badge", textContent: tabName(t)[0]?.toUpperCase() ?? "", style: `--c: ${COLORS[colorIndex(t.repo)]}` })
          : ico(t.repo ? ICONS.worktree : ICONS.home),
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

export async function switchTab(i: number, save = true) {
  if (save && !(await dropEdits())) return;
  // a tab left before its graph came keeps its old scroll
  if (save) Object.assign(tabs[active], { selected: selection.hashes, msg: getMsg(), scroll: commits.length ? $("graph").scrollTop : tabs[active].scroll });
  closeHistory();
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
  $("home").hidden = !!repo;
  paintRepoName();
}

export async function closeTab(i: number) {
  if (i === active && !(await dropEdits())) return;
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
  if (t.repo) items.push(["Rename tab", () => renameTab(i)]);
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
              h("button", { textContent: "×", title: "Close", onclick: (e: Event) => (e.stopPropagation(), closeTab(i), renderTabHits()) }),
            ),
          ],
    ),
  );
}

export function addTab() {
  tabs.push(newTab(""));
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
export const sideFolds = (): Record<string, boolean> => JSON.parse(store(`sidebar-folds:${repo}`) ?? "{}");
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
// this checkout's entry: the repo tool's checkouts list their git dir, not their folder, as the main worktree
export const thisWorktree = () => refs.worktrees.find((w) => w.path === repo) ?? refs.worktrees[0];

export const isHead = (c: Commit) => c.refs.some((r) => r === "HEAD" || r.startsWith("HEAD -> "));
// when each repository was last fetched in the background
const fetchedAt = new Map<string, number>();
// repositories whose background fetch was told to need a passphrase or password, once a run
const toldAuth = new Set<string>();
/** A quiet fetch of the open repository, at most once a minute each: ahead/behind and remote branches stay fresh; failures (offline) stay silent. */
export function autoFetch() {
  const r = repo;
  if (!r || Date.now() - (fetchedAt.get(r) ?? 0) < 60_000 || document.body.classList.contains("busy")) return;
  // never twice at once: on a dead network one can hang for minutes
  fetchedAt.set(r, Infinity);
  run<string>("git_op", { op: "auto-fetch", arg: "" }).then(
    (out) => {
      fetchedAt.set(r, Date.now());
      // with several remotes git names each one even when nothing came
      if (r === repo && out.split("\n").some((l) => l.trim() && !l.startsWith("Fetching "))) refresh();
    },
    (e) => {
      fetchedAt.set(r, Date.now());
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
