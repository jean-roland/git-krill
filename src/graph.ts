// The commit graph, the sidebar of refs, their menus and the find bar.
import { invoke } from "@tauri-apps/api/core";
import { layoutGraph } from "./core.js";
import { closeRebase, ontoRange, openRebase, rebaseRange } from "./rebase";
import { Commit, LOG_LIMIT, Stash, Status, Submodule, Worktree, active, closeTab, commits, dropEdits, fakeCommit, findRef, FOLDS_KEY, gitOp, headHash, hiddenRemotes, hiddenSet, hideItem, isHead, isRepo, keepTab, newTab, opInfo, openRepo, paintRepoName, pull, push, redraw, refs, remoteTags, repo, run, selection, sideFolds, status, switchTab, tabs, thisWorktree, toggleHidden, toggleRemote, updateHidden } from "./repo";
import { $, COLORS, ICONS, MenuItem, ask, askName, basename, copy, dateTimeText, dialog, h, hideBanner, ico, input, mod, plural, popup, say, short, showBanner, spriteId, store, svg, toast } from "./ui";
import { dropTerm } from "./terminal";
import { closePr, mergedHeads, newPr, prChip, prItems, prOf, prRows, pullsHere } from "./pr";
import { conflictCount, conflictLine, fileCounts, opLine, renderPanel, wipFiles } from "./panel";

type Label = { name: string; tag: boolean; head: boolean; local: boolean; remotes: string[] };

const ROW = 26, LANE = 22;
// rows per chunk; the chunks within two of the view are drawn, a fast scroll fills one at a time
const CHUNK = 40;
let findHits: string[] = [];
let findAt = -1;
// the graph rows and their lane colors, drawn by chunks: only those near the view are in the DOM
export let shown: Commit[] = [];
let rowColors: string[] = [];
export let chunks: HTMLElement[] = [];
let laneW = 0;
// how far the lanes are scrolled sideways, when wider than their column
let gx = 0;
// the graph column's widest by default, in px: ten lanes; past it the lanes scroll
const GRAPH_MAX = 10 * LANE + 10;
let graphLayout: { width: number; nodes: number[]; edges: { row: number; lane: number; toRow: number; toLane: number; via: number }[] } = { width: 0, nodes: [], edges: [] };

/* branches sidebar */

// each remote's tag list as a set, made once per answer: thousands of tag rows look into it
const tagSets = new WeakMap<string[], Set<string>>();
const hasTag = (tags: string[] | undefined, name: string) => !!tags && (tagSets.get(tags) ?? tagSets.set(tags, new Set(tags)).get(tags)!).has(name);

/** The cloud on a tag the remotes have, none when no remote has it or none answered. */
function tagCloud(name: string) {
  const on = refs.remotes.filter((r) => hasTag(remoteTags.get(repo)?.[r], name));
  return on.length ? [ico(ICONS.remote, on.map((r) => `${name} on ${r} (remote tag)`).join("\n"))] : [];
}

function trackLabel(track: string) {
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
function sideItem(label: string, icon: string, hash: string, extra: string, cls: string, menu: () => MenuItem[], dbl?: () => unknown, hide?: string) {
  const hidden = !!hide && hiddenSet.has(hide);
  return h(
    "div",
    // the menu is made on right-click: thousands of branches each looking themselves up cost seconds
    { className: `item ${cls}${hidden ? " hidden-ref" : ""}`, title: label, onclick: () => jumpTo(hash), ondblclick: dbl ?? null, oncontextmenu: (e: MouseEvent) => popup(e, menu()) },
    ...(cls === "current" ? [h("span", { className: "ico check", innerHTML: svg(ICONS.check) })] : hide ? [eye(hide, hidden)] : []),
    ico(ICONS[icon]),
    h("span", { className: "label", textContent: label }),
    h("small", { textContent: extra }),
  );
}

export function renderSide() {
  // what the user folded stays folded, per repository
  const r = repo, folds = sideFolds();
  updateHidden();
  // a null count: still being asked, a spinner in its place
  const section = (key: string, title: string, count: number | null, rows: () => HTMLElement[], open: boolean, icon = "") => {
    // the count first: floated right, it keeps its line however narrow the title gets
    const n = h("span", { className: "n" }, count === null ? h("span", { className: "spinner", title: "Asking gh" }) : String(count));
    const d = h("details", { open: folds[key] ?? open }, h("summary", {}, n, ...(icon ? [ico(ICONS[icon])] : []), title));
    // a folded section's rows are made when it first opens
    let filled = false;
    const fill = () => !filled && d.open && ((filled = true), d.append(...rows()));
    fill();
    d.ontoggle = () => (fill(), r === repo && store(FOLDS_KEY, JSON.stringify({ ...sideFolds(), [key]: d.open })));
    d.dataset.key = key;
    return d;
  };
  const local: string[][] = [], tags: string[][] = [], remotes = new Map<string, string[][]>();
  for (const r of refs.refs) {
    if (r.name.startsWith("refs/heads/")) local.push([r.name.slice("refs/heads/".length), r.hash, r.track, r.name]);
    else if (r.name.startsWith("refs/remotes/")) {
      const full = r.name.slice("refs/remotes/".length), remote = full.slice(0, full.indexOf("/"));
      if (!remotes.has(remote)) remotes.set(remote, []);
      remotes.get(remote)!.push([full, r.hash, r.name]);
    } else tags.push([r.name.slice("refs/tags/".length), r.hash, r.name]);
  }
  const localRow = ([name, hash, track, ref]: string[]) => {
    const current = name === status?.branch;
    const row = sideItem(name, "branch", hash, trackLabel(track), current ? "current" : "", () => branchMenu(name, false), () => current || checkoutBranch(name, false), current ? undefined : ref);
    // its upstream was deleted on the remote, like a merged pull request's branch
    if (track === "[gone]") row.append(ico(ICONS.gone, `${findRef(ref)?.upstream || "Its upstream"} was deleted on the remote`));
    const pr = prOf(name, hash);
    if (pr) row.append(prChip(pr));
    return row;
  };
  const remoteRow = ([full, hash, ref]: string[]) => sideItem(full.slice(full.indexOf("/") + 1), "branch", hash, "", "", () => branchMenu(full, true), () => checkoutBranch(full, true), ref);
  const tagRow = ([name, hash, ref]: string[]) => {
    const row = sideItem(name, "tag", hash, "", "", () => tagMenu(name), undefined, ref);
    // an unpushed tag keeps the cloud's place: the laptops stay in one column
    const cloud = tagCloud(name)[0] ?? Object.assign(ico(ICONS.remote), { style: "visibility: hidden" });
    row.append(ico(ICONS.local, `${name} (local tag)`), cloud);
    return row;
  };
  const stashRow = (s: Stash) =>
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
    );
  const worktreeRow = (w: Worktree, k: number) => {
    const here = w === thisWorktree();
    const extra = w.locked ? "locked" : "";
    // its eye is its branch's
    const el = sideItem(w.branch || `detached at ${short(w.head)}`, "worktree", w.head, extra, here ? "current" : "", () => worktreeMenu(w, k === 0), () => here || openWorktree(w.path), here || !w.branch ? undefined : `refs/heads/${w.branch}`);
    el.title = w.path;
    // the main checkout: a house, not a word that reads like its branch
    if (!k) el.append(ico(ICONS.home, "Main checkout"));
    return el;
  };
  // a worktree whose folder is gone is being pruned
  const live = refs.worktrees.filter((w) => !w.prunable);
  // the folder every submodule shares, like submodules/, says nothing on each row
  const dirs = refs.submodules.map((s) => s.path.slice(0, s.path.lastIndexOf("/") + 1));
  const shared = dirs.every((d) => d === dirs[0]) ? (dirs[0] ?? "") : "";
  const submoduleRow = (s: Submodule) => {
    const [icon, cls, state] = submoduleState(s);
    return h(
      "div",
      { className: "item", title: `${s.path}\n${s.url}\n${state}`, ondblclick: () => (s.head ? openSubmodule(s.path) : gitOp("submodule-update", s.path)), oncontextmenu: (e: MouseEvent) => popup(e, submoduleMenu(s)) },
      h("span", { className: `ico sub-state ${cls}`, innerHTML: svg(ICONS[icon]) }),
      ico(ICONS.submodule),
      h("span", { className: "label", textContent: s.path.slice(shared.length) }),
      h("small", { textContent: [s.ahead && `↑${s.ahead}`, s.behind && `↓${s.behind}`].filter(Boolean).join(" ") }),
    );
  };
  paintRepoName();
  $("sidebar").replaceChildren(
    section("local", "Local", local.length, () => local.map(localRow), true, "local"),
    section("remote", "Remote", remotes.size, () => [...remotes].map(([name, rows]) => remoteSection(section(`remote/${name}`, name, rows.length, () => rows.map(remoteRow), false, "globe"), name)), true, "remote"),
    section("tags", "Tags", tags.length, () => tags.map(tagRow), false, "tag"),
    section("stashes", "Stashes", refs.stashes.length, () => refs.stashes.map(stashRow), false, "stash"),
    // shown even empty, for their +: folded until opened
    addButton(section("worktrees", "Worktrees", live.length, () => live.map(worktreeRow), false, "worktree"), "Create a worktree", () => createWorktree("", headHash(), status?.branch ?? "")),
    addButton(section("submodules", "Submodules", refs.submodules.length, () => refs.submodules.map(submoduleRow), false, "submodule"), "Add a submodule", addSubmodule),
    addButton(section("pulls", "Pull requests", pullsHere()?.list.length ?? null, prRows, true, "pr"), "Create a pull request from the checked out branch", newPr),
  );
}

/** A section's + on hover, adding one more of what it lists. */
function addButton(d: HTMLElement, title: string, add: () => unknown) {
  // the fold stays as it is
  d.querySelector("summary .n")!.after(h("button", { className: "add", title, innerHTML: svg(ICONS.a), onclick: (e: Event) => (e.preventDefault(), e.stopPropagation(), add()) }));
  return d;
}

/** `git submodule add`, by default in a folder named after the repository it clones. */
function addSubmodule() {
  dialog("Add a submodule", [["URL", ""], ["Folder (empty: named after the repository)", ""]], "Add", ([url, path]) =>
    url && gitOp("submodule-add", [url, path || url.replace(/(\.git)?\/*$/, "").split(/[/:]/).pop()!]),
  );
}

/** A submodule's state icon, its class and what it means. */
function submoduleState(s: Submodule): [string, string, string] {
  const here = basename(repo);
  if (!s.head) return ["warn", "out", "Not initialized: double-click to check it out"];
  if (!s.recorded) return ["sync", "out", `Added, not in a commit of ${here} yet`];
  if (s.head !== s.recorded) return ["sync", "out", `Out of sync: checked out on another commit than ${here} records`];
  if (s.modified || s.untracked) return ["sync", "out", "Uncommitted changes in it"];
  return ["check", "ok", `In sync with ${here}`];
}

// in this tab, one level deep: a submodule's own submodules open in a tab of their own
export const openSubmodule = (path: string) =>
  tabs[active].parent
    ? (toast(`Opened ${basename(path)} in a new tab`, "A tab steps into one submodule level only.", "info"), openRepo(`${repo}/${path}`))
    : openWorktree(`${repo}/${path}`, repo);

/** Back on the recorded commit, its changed and untracked files dropped, after asking. */
export const discardSubmodule = (path: string) =>
  ask(`Discard every change in submodule ${path}? Its changed and untracked files are lost, and it goes back to the commit ${basename(repo)} records.`, "Discard").then(
    (ok) => ok && gitOp("submodule-discard", path),
  );

function submoduleMenu(s: Submodule): MenuItem[] {
  const out = s.head !== s.recorded, dirty = out || s.modified || s.untracked;
  return [
    { title: s.path, icon: ICONS.submodule },
    ...(s.head
      ? ([
          ...(tabs[active].parent ? [] : [["Open", () => openSubmodule(s.path)]]),
          ["Open in a new tab", () => openRepo(`${repo}/${s.path}`)],
          ...(out ? [["Update to the recorded commit", () => gitOp("submodule-update", s.path)]] : []),
        ] as MenuItem[])
      : ([["Initialize", () => gitOp("submodule-update", s.path)]] as MenuItem[])),
    ...(s.head && dirty ? ([["Discard changes", () => discardSubmodule(s.path)]] as MenuItem[]) : []),
    null,
    ["Edit URL", () => dialog("Edit submodule URL", [["URL", s.url]], "Save", ([url]) => url && url !== s.url && gitOp("submodule-set-url", [s.path, url]))],
    [
      "Delete",
      () =>
        ask(`Delete submodule ${s.path}? Its folder and its clone are removed; the removal is staged, to commit.`, "Delete").then((ok) => ok && gitOp("submodule-delete", [s.path, s.name])),
    ],
    null,
    ["Copy path", () => copy(s.path)],
  ];
}

/** The worktree other than this one that has `branch` checked out, its folder still there. */
export const worktreeOf = (branch: string) => refs.worktrees.find((w) => w.branch === branch && w !== thisWorktree() && !w.prunable);

function worktreeMenu(w: Worktree, main: boolean): MenuItem[] {
  const here = w.path === repo;
  return [
    { title: w.branch || basename(w.path), icon: ICONS.worktree },
    ...(here ? [] : ([["Open worktree", () => openWorktree(w.path)]] as MenuItem[])),
    ...(main || here ? [] : ([["Remove worktree", () => removeWorktree(w)]] as MenuItem[])),
    ...(here || !w.branch ? [] : [hideItem(`refs/heads/${w.branch}`)]),
    null,
    ["Copy path", () => copy(w.path)],
  ];
}

/** Show worktree `path` in this tab, or switch to the tab that has it; a submodule opened from `parent` too. */
export async function openWorktree(path: string, parent = "") {
  const i = tabs.findIndex((t) => t.repo === path);
  if (i >= 0) return switchTab(i);
  if (!(await isRepo(path))) return say(`${path} no longer exists`, true);
  if (!(await dropEdits())) return;
  // the shell ran in the old folder
  dropTerm(tabs[active]);
  // the tab as it was comes back on the way out: its draft, undo steps, selection
  // newTab's own object: its worktree check fills it in later
  tabs[active] = Object.assign(newTab(path, parent), { back: keepTab() });
  await switchTab(active, false);
}

/** `git worktree add` of `branch`, or of a new branch from commit `from`, by default in a folder beside the repository's; this tab then shows it. */
async function createWorktree(branch: string, from = "", busy = "") {
  if (branch && !(await pruneHolder(branch, "go on"))) return;
  // a repo tool checkout keeps them out of its tree, where its build would find them: <top>/../wt
  const main = refs.worktrees[0]?.path ?? repo, top = refs.repoTop;
  const beside = (b: string) => `${top ? `${top.slice(0, top.lastIndexOf("/"))}/wt/${basename(main)}` : main}-${b.replace(/\//g, "-")}`;
  if (!from) return dialog(`Create a worktree from ${branch}`, [["Folder", beside(branch)]], "Create", ([path]) => path && addWorktree("worktree-add", [path, branch]));
  const name = busy ? `New branch name (${busy} is checked out already, a branch goes in one worktree only)` : "New branch name";
  dialog(`Create a worktree from ${busy || short(from)}`, [[name, ""], ["Folder (empty: beside the repository, named after the branch)", ""]], "Create", ([b, path]) =>
    b && addWorktree("worktree-add-new", [path || beside(b), JSON.stringify([b, from])]),
  );
}

async function addWorktree(op: string, args: [string, string]) {
  const r = repo, known = new Set(refs.worktrees.map((w) => w.path));
  // git's own path for it: a typed folder may be relative or unnormalized; another tab's refs would not have it
  const added = (await gitOp(op, args)) && repo === r && refs.worktrees.find((w) => !known.has(w.path));
  if (added) openWorktree(added.path);
}

/** Back from a worktree or a submodule to its repository, in this tab. */
export async function stepBack() {
  const t = tabs[active], parent = t.parent;
  if (!parent || !(await dropEdits())) return;
  // already open in a tab of its own: that one, this one closing
  const open = tabs.find((o) => o !== t && o.repo === parent);
  if (open) return closeTab(active).then(() => switchTab(tabs.indexOf(open)));
  dropTerm(t);
  tabs[active] = t.back?.repo === parent ? t.back : newTab(parent);
  await switchTab(active, false);
}

/** `git worktree remove`, forced after a warning when it has changes; its branch can go too. */
async function removeWorktree(w: Worktree, branchToo = false) {
  const [s, merged] = await Promise.all([invoke<Status>("status", { repo: w.path }).catch(() => null), !w.branch || run<boolean>("is_merged", { branch: w.branch }).catch(() => false)]);
  const dirty = !!s && s.staged.length + s.unstaged.length > 0;
  // this one question covers the branch too: unmerged commits are named in it
  const unmerged = merged ? "" : ` (not merged into ${findRef(`refs/heads/${w.branch}`)?.upstream || status?.branch || "HEAD"})`;
  const r = repo;
  const removed = `Removed worktree ${basename(w.path)}`;
  const remove = (andBranch: boolean) => async () => {
    // one toast for both, the branch's: git's line there has its last commit
    if (!(await gitOp(dirty ? "worktree-force-remove" : "worktree-remove", w.path, true, andBranch ? "" : undefined)) || !andBranch) return;
    // still in the tab it was asked from; else, or the branch kept, the removal is told alone
    if (repo !== r || !(await gitOp(merged ? "branch-delete" : "branch-force-delete", w.branch, true, `${removed} and deleted branch ${w.branch}`))) toast(removed, "", "info");
  };
  const branch = `${merged ? "delete" : "force delete"} branch`;
  // the question bold, what goes with it under it
  const question = `Remove worktree ${basename(w.path)}${dirty ? " and lose its uncommitted changes" : ""}?\n`;
  // asked from the branch: git deletes none a worktree has checked out
  if (branchToo) return dialog(`${question}${w.branch} is checked out there: its folder is deleted, the branch with it${unmerged}.`, [], `Remove and ${branch}`, remove(true));
  dialog(`${question}Its folder is deleted${w.branch ? `, its branch ${w.branch} stays${unmerged}` : ""}.`, [], dirty ? "Force remove" : "Remove", remove(false), w.branch ? [[`Remove and ${branch}`, remove(true)]] : []);
}

/** Eye toggle and menu on a remote's folder in the sidebar. */
function remoteSection(d: HTMLElement, name: string) {
  const hidden = hiddenRemotes().includes(name);
  const sum = d.querySelector("summary")!;
  sum.prepend(eye(name, hidden, () => toggleRemote(name)));
  sum.oncontextmenu = (e) =>
    popup(e, [
      { title: name, icon: ICONS.globe },
      ["Fetch", () => gitOp("fetch-remote", name)],
      ["Edit", () => editRemote(name)],
      [hidden ? "Show" : "Hide", () => toggleRemote(name)],
      null,
      ["Copy link", async () => copy(await webUrl(name))],
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
      if (newName !== name) store(`hidden-remotes:${repo}`, JSON.stringify(hiddenRemotes().map((r) => (r === name ? newName : r))));
    } catch (e) {
      say(String(e), true);
    }
    await redraw();
  });
}

/** Browser URL of a remote: git@host:org/repo.git, ssh://git@host:22/org/repo, https://user@host/org/repo.git. */
export async function webUrl(remote: string) {
  const url = (await run<{ fetch: string }>("remote_urls", { name: remote })).fetch;
  const m = url.match(/^(?:\w+:\/\/)?(?:[^@/]+@)?([^:/]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/);
  return m ? `https://${m[1]}/${m[2]}` : url;
}

/** The remote links point at: the current branch's upstream, else the first remote. */
export function linkRemote() {
  const up = findRef(`refs/heads/${status?.branch}`)?.upstream;
  const names = refs.refs.filter((r) => r.name.startsWith("refs/remotes/")).map((r) => r.name.slice("refs/remotes/".length).split("/")[0]);
  return up ? up.split("/")[0] : (names[0] ?? "");
}

export function jumpTo(hash: string) {
  if (!commits.some((c) => c.hash === hash)) return say(`${short(hash)} is older than the last ${tabs[active].limit} commits`, true);
  closePr(false);
  selection.stash = null;
  selection.hashes = [hash];
  selection.anchor = hash;
  selection.isRange = false;
  paintSelection();
  showRow(hash, "center");
  renderPanel();
}

function showStash(s: Stash, scroll = false) {
  closePr(false);
  selection.stash = s;
  selection.hashes = [];
  selection.anchor = s.hash;
  paintSelection();
  if (scroll) showRow(s.hash, "center");
  renderPanel();
}

const stashOf = (hash: string) => refs.stashes.find((s) => s.hash === hash);

function stashMenu(s: Stash): MenuItem[] {
  return [
    { title: s.subject, icon: ICONS.stash },
    ["Apply", () => gitOp("stash-apply", s.name)],
    ["Pop", () => gitOp("stash-pop", s.name)],
    ["Drop", () => ask(`Drop stash "${s.subject}"? It cannot be undone.`, "Drop").then((ok) => ok && gitOp("stash-drop", s.name))],
    null,
    ["Edit message", () => dialog("Edit stash message", [["Message", s.subject]], "Save", ([m]) => m && gitOp("stash-message", [s.name, m]))],
    hideItem(s.hash),
  ];
}

/** Empty the graph, for another tab. */
export function resetGraph() {
  closeRebase();
  // another tab's graph starts at its first lane
  gx = 0;
  shown = [];
  chunks = [];
  $("rows").replaceChildren();
}

/** Draw the graph from `commits`, at `scroll` when given, before its rows draw: no frame at the old place. */
export function renderGraph(scroll?: number) {
  updateHidden();
  const head = commits.find(isHead);
  const wip = fakeCommit("WIP", head ? [head.hash] : [], "// WIP");
  // always there: an empty WIP still opens the work tree's files (All files)
  const list = [wip, ...commits];
  // a stash hangs off its base commit
  for (const s of refs.stashes) {
    if (hiddenSet.has(s.hash)) continue;
    const at = list.findIndex((c) => c.hash === s.parents[0]);
    if (at >= 0) list.splice(at, 0, fakeCommit(s.hash, [s.parents[0]], s.subject));
  }
  graphLayout = layoutGraph(list);
  // wide enough for its column title
  laneW = Math.max(graphLayout.width * LANE + 10, 64);
  $("graph").style.setProperty("--lane-w", `${laneW}px`);
  shown = list;
  rowColors = list.map((_, i) => laneColor(graphLayout.nodes[i]));
  chunks = Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, k) =>
    h("div", { className: "chunk", style: `height: ${Math.min(CHUNK, list.length - k * CHUNK) * ROW}px` }),
  );
  const tab = tabs[active], more = commits.length >= tab.limit;
  const loadMore = h("button", { className: "load-more", innerHTML: svg(ICONS.down), onclick: () => ((tab.limit += LOG_LIMIT), (loadMore.disabled = true), redraw()) }, "Load more commits");
  $("rows").replaceChildren(...chunks, ...(more ? [loadMore] : []));
  if (scroll !== undefined) $("graph").scrollTop = scroll;
  scrollLanes();
  drawRows();
  if (!$("find").hidden) markHits();
}

/** The graph column's width: the lanes', up to the one dragged (or GRAPH_MAX). */
const graphW = () => Math.min(laneW, parseFloat($("graph").style.getPropertyValue("--graph-max")) || GRAPH_MAX);

/** The lanes scrolled `by` px sideways, kept within them; a cut edge fades. */
export function scrollLanes(by = 0) {
  const g = $("graph"), w = graphW();
  gx = Math.max(0, Math.min(laneW - w, gx + by));
  g.style.setProperty("--gx", `${gx}px`);
  g.classList.toggle("cut-left", gx > 0);
  g.classList.toggle("cut-right", gx + w < laneW);
  // its scrollbar along, once shown: an equal value fires no scroll back
  $("lane-bar").scrollLeft = gx;
}

/** The lanes' scrollbar dragged. */
export const laneBarScrolled = () => scrollLanes($("lane-bar").scrollLeft - gx);

/** A sideways wheel, or Shift with the wheel, scrolls the lanes when they are wider than their column. */
export function wheelLanes(e: WheelEvent) {
  // a touchpad's vertical swipe drifts sideways a little: the larger delta wins
  const dx = e.shiftKey ? e.deltaX || e.deltaY : Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0;
  if (!dx || laneW <= graphW()) return;
  e.preventDefault();
  // a mouse notch is ~100 px, most of the column: two lanes at most a step
  scrollLanes(Math.sign(dx) * Math.min(Math.abs(dx), 2 * LANE));
}

const laneX = (l: number) => l * LANE + LANE / 2 + 4;
const rowY = (r: number) => r * ROW + ROW / 2;
const laneColor = (l: number) => COLORS[l % COLORS.length];

/** The lanes of rows `from` to `to`: the edges crossing them, their dots and label links. */
function lanesSvg(from: number, to: number) {
  const X = laneX, Y = rowY, color = laneColor, list = shown;
  let svg = "";
  for (const e of graphLayout.edges) {
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
    // the hollow WIP ring: its line leaves from the rim
    if (list[e.row].hash === "WIP") d = d.replace(/^M([\d.]+) ([\d.]+)/, (_, x, y) => `M${x} ${+y + 9}`);
    svg += `<path d="${d}" stroke="${color(e.via)}"${dash}/>`;
  }
  // commits show their author, merges stay a small dot
  for (let i = from; i < to; i++) {
    const c = list[i], l = graphLayout.nodes[i], at = `cx="${X(l)}" cy="${Y(i)}"`;
    // the size of an author's ring, dashed in its lane's colour like the line it starts
    if (c.hash === "WIP") svg += `<circle ${at} r="9" style="stroke:${color(l)}" class="wip"/>`;
    // a stash: the same ring squared, its icon in the lane's colour too
    else if (stashOf(c.hash))
      svg +=
        `<rect x="${X(l) - 10}" y="${Y(i) - 10}" width="20" height="20" style="stroke:${color(l)}" class="stash"/>` +
        `<svg x="${X(l) - 6}" y="${Y(i) - 6}" width="12" height="12" viewBox="0 0 24 24" style="color:${color(l)}"><path d="${ICONS.stash}"/></svg>`;
    else if (c.parents.length > 1) svg += `<circle ${at} r="4" fill="${color(l)}"/>`;
    else
      svg +=
        `<use href="#${spriteId(c.author)}" x="${X(l) - 9}" y="${Y(i) - 9}" width="18" height="18"/>` +
        `<circle ${at} r="9" style="stroke:${color(l)}" class="av"/>`;
    // labelled commits get a line from their label column to the dot, under it
    if (labels(c).length) svg = `<path d="M0 ${Y(i) + 0.5}H${X(l)}" stroke="${color(l)}" class="link"/>` + svg;
  }
  // the view box keeps whole-graph coordinates, the svg clips the edges at the chunk ends
  return `<svg class="lanes" width="${laneW}" height="${(to - from) * ROW}" viewBox="0 ${from * ROW} ${laneW} ${(to - from) * ROW}">${svg}</svg>`;
}

/** Redraw the WIP row alone, if drawn: its counts change far more often than the graph. */
export function paintWipRow() {
  const row = $("rows").querySelector(".row.wip");
  if (row && shown[0]?.hash === "WIP") row.replaceWith(graphRow(shown[0], rowColors[0], laneX(graphLayout.nodes[0])));
}
function fillChunk(k: number) {
  const from = k * CHUNK, to = Math.min(shown.length, from + CHUNK);
  chunks[k].innerHTML = `<div class="lane-box">${lanesSvg(from, to)}</div>`;
  chunks[k].append(...shown.slice(from, to).map((c, i) => graphRow(c, rowColors[from + i], laneX(graphLayout.nodes[from + i]))));
}

/** Draw the chunks around the view, empty the others. */
export function drawRows() {
  const gr = $("graph"), first = Math.floor(gr.scrollTop / ROW / CHUNK) - 2, last = Math.floor((gr.scrollTop + gr.clientHeight) / ROW / CHUNK) + 2;
  chunks.forEach((el, k) => {
    const near = k >= first && k <= last;
    if (near && !el.childElementCount) fillChunk(k);
    else if (!near && el.childElementCount) el.replaceChildren();
  });
}

/** Scroll the history to the row of `hash`, drawing its chunk first. */
export function showRow(hash: string, block: ScrollLogicalPosition) {
  const i = shown.findIndex((c) => c.hash === hash);
  if (i < 0) return;
  if (!chunks[Math.floor(i / CHUNK)].childElementCount) fillChunk(Math.floor(i / CHUNK));
  document.querySelector(`.row[data-hash="${hash}"]`)?.scrollIntoView({ block });
  // its dot into view too, in the middle of the column
  const x = laneX(graphLayout.nodes[i]), w = graphW();
  if (x - LANE / 2 < gx || x + LANE / 2 > gx + w) scrollLanes(x - w / 2 - gx);
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
      const tag = r.slice("tag: ".length);
      if (!hiddenSet.has(tag)) get(tag.slice("refs/tags/".length), true);
    }
    else if (hiddenSet.has(r)) continue;
    else if (r.startsWith("refs/heads/")) {
      const l = get(r.slice("refs/heads/".length));
      l.local = true;
      l.head ||= r !== ref;
    } else if (r.startsWith("refs/remotes/") && !r.endsWith("/HEAD")) {
      const full = r.slice("refs/remotes/".length), slash = full.indexOf("/"), remote = full.slice(0, slash);
      // a remote ref of no configured remote, like the `repo` tool's m/<branch>, is no remote branch
      if (refs.remotes.includes(remote)) get(full.slice(slash + 1)).remotes.push(remote);
    }
  }
  return [...out.values()].sort((a, b) => +b.head - +a.head || +a.tag - +b.tag || +b.local - +a.local);
}

function chip(l: Label, hash: string) {
  const el = h(
    "span",
    {
      className: `ref${l.head ? " is-head" : ""}${l.tag ? " tag" : ""}`,
      title: l.tag ? `${l.name} (tag)` : l.head ? l.name : `${l.name}: double-click to checkout`,
      // in a dropped-down list a click picks nothing: the panel stays where it is
      onclick: (e: MouseEvent) => (e.currentTarget as HTMLElement).closest(".multi") && e.stopPropagation(),
      ondblclick: (e: MouseEvent) => (e.stopPropagation(), !l.tag && !l.head && checkoutBranch(labelRef(l), !l.local)),
      oncontextmenu: (e: MouseEvent) => (e.stopPropagation(), popup(e, l.tag ? tagMenu(l.name) : branchMenu(labelRef(l), !l.local))),
    },
    ...(l.head ? [ico(ICONS.check)] : []),
    h("span", { className: "ref-name", textContent: l.name }),
  );
  if (l.tag) el.append(ico(ICONS.tag));
  if (l.tag) el.append(...tagCloud(l.name));
  if (l.local) el.append(ico(ICONS.local, `${l.name} (local branch)`));
  if (l.remotes.length) el.append(ico(ICONS.remote, l.remotes.map((r) => `${r} -> ${l.name} (remote branch)`).join("\n")));
  const wt = l.local && worktreeOf(l.name);
  if (wt) el.append(ico(ICONS.worktree, `Checked out in the worktree ${wt.path}`));
  const pr = !l.tag && prOf(l.name, hash);
  // before the name: the label widens rightwards on hover, it would slide away from the pointer
  if (pr) el.querySelector(".ref-name")!.before(prChip(pr));
  return el;
}

function graphRow(c: Commit, lane: string, nodeX: number) {
  const ls = labels(c), stash = stashOf(c.hash);
  const row = h(
    "div",
    {
      className: `row${c.hash === "WIP" ? (conflictCount() ? " wip conflict" : " wip") : ""}${isHead(c) ? " row-head" : ""}${selection.hashes.includes(c.hash) || selection.stash?.hash === c.hash ? " sel" : ""}${findHits.includes(c.hash) ? " match" : ""}`,
      onclick: (e: MouseEvent) => (stash ? showStash(stash) : clickRow(e, c.hash)),
      oncontextmenu: (e: MouseEvent) => (stash ? popup(e, stashMenu(stash)) : c.hash !== "WIP" && commitMenu(e, c)),
    },
    h(
      "div",
      { className: `refs${ls.length ? " has" : ""}${ls.length > 1 ? " multi" : ""}` },
      h("div", { className: "refs-in" }, ...ls.map((l) => chip(l, c.hash)), ...(ls.length > 1 ? [h("span", { className: "more", textContent: `+${ls.length - 1}` })] : [])),
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
          { className: "subject", title: `${c.author} · ${dateTimeText(c.time)}` },
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
  selection.stash = null;
  const idx = (x: string) => commits.findIndex((c) => c.hash === x);
  if (hash !== "WIP" && e.shiftKey && idx(selection.anchor) >= 0) {
    const [a, b] = [idx(selection.anchor), idx(hash)].sort((x, y) => x - y);
    selection.hashes = commits.slice(a, b + 1).map((c) => c.hash);
    selection.isRange = true;
  } else if (hash !== "WIP" && mod(e)) {
    const s = selection.hashes.filter((x) => x !== "WIP");
    selection.hashes = s.includes(hash) ? s.filter((x) => x !== hash) : [...s, hash];
    if (!selection.hashes.length) selection.hashes = ["WIP"];
    selection.anchor = hash;
    selection.isRange = false;
  } else {
    selection.held = hash === "WIP";
    selection.hashes = [hash];
    selection.anchor = hash;
    selection.isRange = false;
  }
  paintSelection();
  renderPanel();
}

export function paintSelection() {
  document.querySelectorAll<HTMLElement>(".row").forEach((r) => r.classList.toggle("sel", selection.hashes.includes(r.dataset.hash!) || selection.stash?.hash === r.dataset.hash));
}

/** The ref a label stands for: its local branch, else its first remote's. */
const labelRef = (l: Label) => (l.local ? l.name : `${l.remotes[0]}/${l.name}`);

/** Whether to go on with `local`: a worktree whose folder is gone holds it, and git refuses it, until pruned; asked to prune first. */
async function pruneHolder(local: string, verb: string) {
  const stale = refs.worktrees.find((w) => w.branch === local && w.prunable);
  if (!stale) return true;
  const q = `${local} is held by the worktree ${basename(stale.path)}, whose folder is gone.\nEvery worktree whose folder is gone is pruned first.`;
  return (await ask(q, `Prune and ${verb}`)) && gitOp("worktree-prune");
}

/** Check out `name`; a remote branch whose local one is elsewhere catches it up when only behind, else asks: reset the local one to it, or take it as it is. */
async function checkoutBranch(name: string, remote: boolean) {
  const local = remote ? name.slice(name.indexOf("/") + 1) : name;
  // git refuses a branch another worktree has (but 2.43's checkout -B takes it, leaving its files behind): open that worktree instead
  const wt = worktreeOf(local);
  if (wt) return openHolder(wt, local);
  if (!(await pruneHolder(local, "checkout"))) return;
  const mine = findRef(`refs/heads/${local}`), theirs = findRef(`refs/remotes/${name}`);
  if (!remote || !mine || !theirs || mine.hash === theirs.hash) return gitOp("checkout", local);
  // only behind its upstream: catching up drops nothing, no question
  if (mine.upstream === name && mine.track.startsWith("[behind")) return gitOp("checkout-reset", [local, `refs/remotes/${name}`]);
  // "[ahead 1, behind 2]" against its upstream
  const track = mine.upstream === name && mine.track ? ` (${mine.track.slice(1, -1)})` : "";
  const drops = /ahead/.test(track) ? `, its commits that are not on ${name} leave the branch` : "";
  dialog(
    `Local ${local} is not at ${name}${track}. Reset it to ${name}${drops}?`,
    [],
    `Reset ${local} to ${name}`,
    () => gitOp("checkout-reset", [local, `refs/remotes/${name}`]),
    [[`Checkout ${local}`, () => gitOp("checkout", local)]],
  );
}

/** Open worktree `wt`, which has `branch`; its toast offers to check `branch` out in the folder left instead, the two trading branches. */
async function openHolder(wt: Worktree, branch: string) {
  const from = repo, mine = status?.branch;
  await openWorktree(wt.path);
  if (repo !== wt.path) return;
  const t = toast(`Switched to worktree ${basename(wt.path)}`, `${branch} is checked out there.`, "info");
  // detached, the folder left has no branch to trade
  if (!mine) return;
  const swap = async () => {
    t.dismiss();
    // the tab as it was, when this one replaced it
    const t0 = tabs[active];
    await (t0.parent === from && t0.back?.repo === from ? stepBack() : openWorktree(from));
    if (repo === from) gitOp("worktree-swap", [wt.path, branch]);
  };
  t.el.querySelector(".t-body")!.append(h("div", { className: "t-actions" }, h("button", { textContent: `Check it out in ${basename(from)} instead`, onclick: swap })));
}

/** Checkout, merge and rebase for branch `name` (a remote one as "remote/branch"); none for the checked out one. */
function refMenu(name: string, remote: boolean): MenuItem[] {
  // the full name: a bare one may resolve to a tag or the stash list of the same name
  const branch = status?.branch || "HEAD", ref = remote ? `refs/remotes/${name}` : `refs/heads/${name}`, sha = findRef(ref)?.hash ?? "";
  if (!remote && name === status?.branch) return [];
  // already in HEAD: nothing to merge, nothing to replay
  const merged = inHistory(sha, headHash());
  // a branch another worktree has: checkout opens that worktree, or the two trade branches
  const holder = worktreeOf(remote ? name.slice(name.indexOf("/") + 1) : name), from = status?.branch;
  const checkout: MenuItem = holder
    ? ["Checkout ({icon})", () => checkoutBranch(name, remote), `Opens the worktree ${basename(holder.path)}, where it is checked out`, ICONS.worktree]
    : ["Checkout", () => checkoutBranch(name, remote)];
  return [
    checkout,
    ...(holder && !remote && from
      ? ([[`Checkout, swap with {icon}${basename(holder.path)}`, () => gitOp("worktree-swap", [holder.path, name]), `${basename(holder.path)} gets ${from}; each folder keeps its uncommitted changes`, ICONS.worktree]] as MenuItem[])
      : []),
    ...(merged
      ? []
      : ([
          [`Merge into ${branch}`, () => gitOp("merge", ref)],
          [`Rebase ${branch} onto this branch`, () => gitOp("rebase", ref)],
        ] as MenuItem[])),
    [`Interactive rebase ${branch} onto this branch`, () => openRebase(sha, ontoRange(sha))],
  ];
}

function commitMenu(e: MouseEvent, c: Commit) {
  const branch = status?.branch || "HEAD", ls = labels(c).filter((l) => !l.tag);
  const remote = ls[0] && !ls[0].local ? ls[0].remotes[0] : linkRemote();
  // HEAD's own history is reset to, not rebased onto or picked
  const mine = inHistory(c.hash, commits.find(isHead)?.hash ?? "");
  // a reset undoes the branch's own commits or catches up with its remote one, nothing else
  const up = findRef(`refs/heads/${status?.branch}`)?.upstream, upHash = up ? (findRef(`refs/remotes/${up}`)?.hash ?? "") : "";
  const resettable = mine || (!!upHash && inHistory(c.hash, upHash)), range = mine && !isHead(c) ? rebaseRange(c) : null;
  const [newBranch, newTag] = createItems(c.hash);
  popup(e, [
    { title: `${short(c.hash)} ${c.subject}`, icon: ICONS.commit },
    ["Checkout (detached)", () => gitOp("checkout", c.hash)],
    ...(mine
      ? []
      : ([
          [`Rebase ${branch} onto this commit`, () => gitOp("rebase", c.hash)],
          [`Interactive rebase ${branch} onto this commit`, () => openRebase(c.hash, ontoRange(c.hash))],
          ["Cherry-pick", () => gitOp("cherry-pick", c.hash)],
        ] as MenuItem[])),
    ...(resettable ? ([[`Reset ${branch} to this commit`, resetItems(c.hash)]] as MenuItem[]) : []),
    ...(mine && !isHead(c) ? ([[range ? `Interactive rebase of the ${range.length} commits above` : "Interactive rebase from here", () => openRebase(c.hash, range)]] as MenuItem[]) : []),
    null,
    newBranch,
    ["Create worktree from this commit", () => createWorktree("", c.hash)],
    ["Revert commit", () => gitOp("revert", c.hash)],
    newTag,
    null,
    ["Copy commit SHA", () => copy(c.hash)],
    ...(remote ? ([[`Copy link to commit on ${remote}`, async () => copy(`${await webUrl(remote)}/commit/${c.hash}`)]] as MenuItem[]) : []),
  ]);
}

/** Move `rows`, this branch's commits above `base`, newest first, to a new branch then checked out and pushed to this branch's remote; this branch goes back to `base`, the files stay. */
function moveAndPush(base: string, rows: Commit[]) {
  const branch = status?.branch ?? "", up = findRef(`refs/heads/${branch}`)?.upstream ?? "";
  const remote = refs.remotes.find((r) => up.startsWith(`${r}/`)) ?? "origin";
  // by name when its upstream is there
  const back = up && findRef(`refs/remotes/${up}`)?.hash === base ? up : short(base);
  const n = plural(rows.length, "commit");
  // the oldest one's subject: "fix(station): reject unknown ones" -> fix-station-reject-unknown-ones
  const named = rows[rows.length - 1].subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "");
  dialog(`Move ${n} to a new branch\n${branch} goes back to ${back}; your files stay as they are.`, [["New branch name", named]], "Move and push", async ([name]) => {
    if (!name) return;
    // one toast for both, the push's: the server's pull request link comes with it
    const ok = await gitOp("branch-move", [name, base], false, "");
    if (ok) gitOp("push-upstream", [remote, name], true, `Moved ${n} to ${name}; ${branch} is back at ${back}; pushed ${name} to ${remote}`);
  });
}

/** A push of `branch` refused as protected: a banner offers to move its unpushed commits to a new branch and push that one. */
export function offerMove(branch: string) {
  const up = findRef(`refs/heads/${branch}`)?.upstream ?? "", base = findRef(`refs/remotes/${up}`)?.hash ?? "";
  const remote = refs.remotes.find((r) => up.startsWith(`${r}/`)) ?? "its remote";
  const rows = base ? ontoRange(base) : null;
  const refused = `Push rejected: ${branch} is protected on ${remote}.`;
  // a merge among them, or past the loaded commits
  if (!rows?.length) return showBanner(h("span", { textContent: `${refused} Move its commits to a new branch and push that one.` }));
  showBanner(
    h("span", { textContent: `${refused} Move your ${plural(rows.length, "commit")} to a new branch and push that one?` }),
    h("button", { className: "primary", textContent: "Move and push", onclick: () => (hideBanner(), moveAndPush(base, rows)) }),
  );
}

/** Whether `hash` is commit `from` or one of its loaded ancestors. */
function inHistory(hash: string, from: string) {
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const todo = [from], seen = new Set<string>();
  while (todo.length) {
    const at = todo.pop()!;
    if (at === hash) return true;
    if (!at || seen.has(at)) continue;
    seen.add(at);
    todo.push(...(byHash.get(at)?.parents ?? []));
  }
  return false;
}

/** Branch `name` (a remote one as "remote/branch"): the same menu in the sidebar and on graph labels. */
function branchMenu(name: string, remote: boolean): MenuItem[] {
  const ref = findRef(remote ? `refs/remotes/${name}` : `refs/heads/${name}`);
  const sha = ref?.hash ?? "", current = !remote && name === status?.branch;
  // where the branch lives on a remote: itself, or its upstream of the same name on the same commit, as their shared label shows
  const up = ref?.upstream ?? "";
  const onRemote = remote ? name : up.slice(up.indexOf("/") + 1) === name && findRef(`refs/remotes/${up}`)?.hash === sha ? up : "";
  const slash = onRemote.indexOf("/"), rem = onRemote.slice(0, slash), remBranch = onRemote.slice(slash + 1);
  // a remote branch checks out as the local one of the same name
  const local = remote ? remBranch : name, [newBranch, newTag] = createItems(sha);
  return [
    { title: name, icon: ICONS.branch },
    ...refMenu(name, remote),
    null,
    ...(current ? ([["Pull", pull], ["Push", push], null] as MenuItem[]) : []),
    // the commit's own actions (reset, revert) are on its row
    newBranch,
    // git checks a branch out in one worktree only: a busy one starts a new branch from its tip
    ["Create worktree from this branch", () => (local === status?.branch || worktreeOf(local) ? createWorktree("", sha, local) : createWorktree(local))],
    newTag,
    null,
    ...(remote ? [] : ([["Rename", () => askName("New branch name", name, (n) => gitOp("branch-rename", [name, n]))]] as MenuItem[])),
    // is_merged tests against the upstream, wherever it is
    ...(remote
      ? []
      : ([current ? ["Delete local", null, "Can't delete the checked out branch: check out another one first"] : ["Delete local", () => deleteBranch(name, findRef(`refs/remotes/${up}`) ? up : "")]] as MenuItem[])),
    // a local branch's upstream too, one menu for both: git deletes it even with the local one checked out
    ...(onRemote
      ? ([[`Delete on ${rem}`, () => ask(`Delete branch ${remBranch} on ${rem}? This pushes the deletion.`, "Delete").then((ok) => ok && gitOp("push-delete", [rem, `refs/heads/${remBranch}`]))]] as MenuItem[])
      : []),
    ...(current || !ref ? [] : [hideItem(ref.name)]),
    null,
    ...prItems(name, remote, sha),
    null,
    ["Copy branch name", () => copy(remote ? remBranch : name)],
    ...(rem ? ([[`Copy link to branch on ${rem}`, async () => copy(`${await webUrl(rem)}/tree/${remBranch}`)]] as MenuItem[]) : []),
  ];
}

/** `git branch -d`, or `-D` after saying what is lost when the branch is merged nowhere. */
async function deleteBranch(name: string, upstream: string) {
  // the main folder's stays: it cannot be removed
  const wt = worktreeOf(name);
  if (wt && wt !== refs.worktrees[0]) return removeWorktree(wt, true);
  // a worktree whose folder is gone holds it: pruned first, in the same question, one toast
  const stale = refs.worktrees.find((w) => w.branch === name && w.prunable);
  const prune = stale ? `\nIts worktree ${basename(stale.path)}, whose folder is gone, is pruned first, with any other gone one.` : "";
  const go = async (op: string) => (!stale || (await gitOp("worktree-prune", "", true, ""))) && gitOp(op, name);
  const merged = await run<boolean>("is_merged", { branch: name }).catch(() => false);
  if (merged) return (await ask(`Delete branch ${name}?${prune}`, "Delete")) && go("branch-delete");
  // a squash-merged pull request leaves its branch unmerged here
  const into = upstream || status?.branch || "HEAD";
  if (await ask(`${name} is not merged into ${into}. Delete it with its unmerged commits?${prune}`, "Force delete")) go("branch-force-delete");
}

// per repository and branch: gone branches weighed this run, so a refresh does not offer them again
const goneSeen = new Set<string>();

/** A toast offering to delete the local branches deleted on their remote and merged there; Keep, or closing it, remembers them. */
export async function offerGone() {
  const r = repo, keptKey = `gone-kept:${refs.worktrees[0]?.path ?? r}`;
  const kept: string[] = JSON.parse(store(keptKey) ?? "[]");
  // the checked out branch and a worktree's go from their own menu
  const gone = refs.refs
    .filter((x) => x.name.startsWith("refs/heads/") && x.track === "[gone]")
    .map((x) => ({ branch: x.name.slice("refs/heads/".length), hash: x.hash, upstream: x.upstream }))
    .filter((x) => x.branch !== status?.branch && !worktreeOf(x.branch) && !kept.includes(x.branch) && !goneSeen.has(`${r}\0${x.branch}`));
  if (!gone.length) return;
  gone.forEach((x) => goneSeen.add(`${r}\0${x.branch}`));
  // a squash or rebase merge leaves the branch unmerged by ancestry: its merged pull request's head is its tip
  const heads = await mergedHeads();
  const isMerged = async (x: (typeof gone)[number]) => {
    if (heads.has(x.hash)) return true;
    return run<boolean>("is_merged", { branch: x.branch }).catch(() => false);
  };
  const verdicts = await Promise.all(gone.map(isMerged));
  const merged = gone.filter((_, i) => verdicts[i]);
  if (repo !== r || !merged.length) return;
  const names = merged.map((x) => x.branch);
  const remotes = new Set(merged.map((x) => refs.remotes.find((rm) => x.upstream.startsWith(`${rm}/`)) ?? ""));
  const where = remotes.size === 1 ? [...remotes][0] : "their remotes";
  const title = names.length === 1 ? `${names[0]} was deleted on ${where}` : `${names.length} branches were deleted on ${where}`;
  const body = names.length === 1 ? "It is merged: delete the local branch too?" : `They are merged: delete the local ones too?\n${names.join("\n")}`;
  const t = toast(title, body, "info", true);
  const keep = () => store(keptKey, JSON.stringify([...JSON.parse(store(keptKey) ?? "[]"), ...names]));
  const remove = () => {
    // the toast stays up across tabs: its branches are its repository's
    if (repo !== r) return say(`These branches are in ${basename(r)}: delete them from its tab`, true);
    t.dismiss();
    gitOp("branches-delete", names.join("\0"));
  };
  t.el.querySelector(".x")!.addEventListener("click", keep);
  t.el.querySelector(".t-body")!.append(
    h("div", { className: "t-actions" }, h("button", { className: "primary", textContent: "Delete", onclick: remove }), h("button", { textContent: "Keep", onclick: () => (keep(), t.dismiss()) })),
  );
}

function tagMenu(name: string): MenuItem[] {
  // an unanswered remote offers both push and delete
  const known = remoteTags.get(repo) ?? {}, has = (r: string) => known[r]?.includes(name) ?? true, lacks = (r: string) => !known[r]?.includes(name);
  const on = refs.remotes.filter((r) => known[r]?.includes(name)), link = [linkRemote(), ...on].find((r) => on.includes(r));
  return [
    { title: name, icon: ICONS.tag },
    ["Checkout (detached)", () => gitOp("checkout", `refs/tags/${name}`)],
    null,
    ...refs.remotes.filter(lacks).map((r): MenuItem => [`Push to ${r}`, () => gitOp("tag-push", [r, name])]),
    ["Rename", () => askName(on.length ? `New tag name, on ${on.join(", ")} too` : "New tag name", name, (n) => n !== name && gitOp("tag-rename", [name, JSON.stringify([n, ...on])]))],
    // no question: the commit stays, and a pushed tag comes back with a fetch
    ["Delete local", () => gitOp("tag-delete", name)],
    ...refs.remotes.filter(has).map(
      (r): MenuItem => [
        `Delete on ${r}`,
        () => ask(`Delete tag ${name} on ${r}? This pushes the deletion.`, "Delete").then((ok) => ok && gitOp("push-delete", [r, `refs/tags/${name}`])),
      ],
    ),
    hideItem(`refs/tags/${name}`),
    null,
    ["Copy tag name", () => copy(name)],
    ...(link ? ([[`Copy link to tag on ${link}`, async () => copy(`${await webUrl(link)}/tree/${name}`)]] as MenuItem[]) : []),
  ];
}

/** Soft, mixed and hard resets of the checked out branch to `sha`. */
function resetItems(sha: string): MenuItem[] {
  const b = status?.branch || "HEAD";
  return [
    ["Soft: keep the changes staged", () => gitOp("reset-soft", sha)],
    ["Mixed: keep the changes unstaged", () => gitOp("reset-mixed", sha)],
    ["Hard: discard every change", () => ask(`Reset ${b} to ${short(sha)} and discard every uncommitted change?`, "Reset").then((ok) => ok && gitOp("reset-hard", sha))],
  ];
}

const createItems = (sha: string): MenuItem[] => [
  ["Create branch here", () => askName("New branch name", "", (n) => gitOp("branch-create", [n, sha]))],
  ["Create tag here", () => askName("Tag name", "", (n) => gitOp("tag-create", [n, sha]))],
];

/** Mark the commits matching the search box; non-matching rows dim. */
function markHits() {
  const q = input("find-q").value.trim().toLowerCase();
  findHits = q
    ? commits.filter((c) => c.hash.startsWith(q) || `${c.subject}\n${c.body}\n${c.author}\n${c.refs.join(" ")}`.toLowerCase().includes(q)).map((c) => c.hash)
    : [];
  const set = new Set(findHits);
  $("rows").classList.toggle("finding", !!q);
  document.querySelectorAll<HTMLElement>("#rows .row").forEach((r) => r.classList.toggle("match", set.has(r.dataset.hash!)));
  $("find-n").textContent = q ? `${findHits.length ? findAt + 1 : 0}/${findHits.length}` : "";
}

export function findStep(step: number) {
  if (!findHits.length) return;
  findAt = (findAt + step + findHits.length) % findHits.length;
  $("find-n").textContent = `${findAt + 1}/${findHits.length}`;
  jumpTo(findHits[findAt]);
}

let findIdle = 0;
/** Search as typed, once the typing pauses: a jump runs git. */
export function findTyped() {
  clearTimeout(findIdle);
  findIdle = setTimeout(() => {
    findAt = -1;
    markHits();
    findStep(1);
  }, 150);
}

export function openFind() {
  $("find").hidden = false;
  input("find-q").select();
  input("find-q").focus();
}

export function closeFind() {
  $("find").hidden = true;
  $("rows").classList.remove("finding");
}
