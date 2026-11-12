// The commit graph, the sidebar of refs, their menus and the find bar.
import { invoke } from "@tauri-apps/api/core";
import { layoutGraph } from "./core.js";
import { closeRebase, ontoRange, openRebase, rebaseRange } from "./rebase";
import { Commit, LOG_LIMIT, Stash, Status, Submodule, Worktree, active, commits, dropEdits, fakeCommit, findRef, foldsKey, gitOp, hiddenRemotes, hiddenSet, hideItem, isHead, isRepo, newTab, opInfo, openRepo, paintRepoName, pull, push, redraw, refs, remoteTags, repo, run, selection, sideFolds, status, switchTab, tabs, thisWorktree, toggleHidden, toggleRemote, updateHidden } from "./repo";
import { $, COLORS, ICONS, MenuItem, ask, askName, basename, copy, dateFmt, dialog, h, ico, input, popup, say, short, spriteId, store, svg } from "./ui";
import { dropTerm } from "./terminal";
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
let graphLayout: { width: number; nodes: number[]; edges: { row: number; lane: number; toRow: number; toLane: number; via: number }[] } = { width: 0, nodes: [], edges: [] };

/* branches sidebar */

/** The cloud on a tag the remotes have, none when no remote has it or none answered. */
function tagCloud(name: string) {
  const on = refs.remotes.filter((r) => remoteTags.get(repo)?.[r]?.includes(name));
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
  const section = (key: string, title: string, count: number, rows: () => HTMLElement[], open: boolean, icon = "") => {
    const d = h("details", { open: folds[key] ?? open }, h("summary", {}, ...(icon ? [ico(ICONS[icon])] : []), title, h("span", { className: "n", textContent: String(count) })));
    // a folded section's rows are made when it first opens
    let filled = false;
    const fill = () => !filled && d.open && ((filled = true), d.append(...rows()));
    fill();
    d.ontoggle = () => (fill(), r === repo && store(foldsKey(), JSON.stringify({ ...sideFolds(), [key]: d.open })));
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
    const extra = w.locked && !w.prunable ? "locked" : "";
    const open = () => (w.prunable ? prune(w) : openWorktree(w.path));
    const el = sideItem(w.branch || `detached at ${short(w.head)}`, "worktree", w.head, extra, here ? "current" : "", () => worktreeMenu(w, k === 0), () => here || open());
    el.title = w.path;
    // the main checkout: a house, not a word that reads like its branch
    if (!k) el.append(ico(ICONS.home, "Main checkout"));
    if (w.prunable) el.append(ico(ICONS.folderGone, `${w.path} is gone: double-click to prune it from the list`));
    return el;
  };
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
    // optional sections, last and only when there is something: the checkout alone is no list of worktrees
    ...(refs.worktrees.length > 1 ? [section("worktrees", "Worktrees", refs.worktrees.length, () => refs.worktrees.map(worktreeRow), false, "worktree")] : []),
    ...(refs.submodules.length ? [section("submodules", "Submodules", refs.submodules.length, () => refs.submodules.map(submoduleRow), false, "submodule")] : []),
  );
}

/** A submodule's state icon, its class and what it means. */
function submoduleState(s: Submodule): [string, string, string] {
  const here = basename(repo);
  if (!s.head) return ["warn", "out", "Not initialized: double-click to check it out"];
  if (s.head !== s.recorded) return ["sync", "out", `Out of sync: checked out on another commit than ${here} records`];
  if (s.modified || s.untracked) return ["sync", "out", "Uncommitted changes in it"];
  return ["check", "ok", `In sync with ${here}`];
}

// in this tab, one level deep: a submodule's own submodules open in a tab of their own
export const openSubmodule = (path: string) => (tabs[active].parent ? openRepo(`${repo}/${path}`) : openWorktree(`${repo}/${path}`, repo));

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
const worktreeOf = (branch: string) => refs.worktrees.find((w) => w.branch === branch && w !== thisWorktree() && !w.prunable);

const prune = (w: Worktree) =>
  ask(`The folder of ${basename(w.path)} is gone. Prune it from the worktree list?`, "Prune").then((ok) => ok && gitOp("worktree-prune"));

function worktreeMenu(w: Worktree, main: boolean): MenuItem[] {
  const here = w.path === repo;
  return [
    { title: w.branch || basename(w.path), icon: ICONS.worktree },
    ...(here || w.prunable ? [] : ([["Open worktree", () => openWorktree(w.path)]] as MenuItem[])),
    ["Copy path", () => copy(w.path)],
    ...(w.prunable
      ? ([["Prune: its folder is gone", () => prune(w)]] as MenuItem[])
      : main || here
        ? []
        : ([["Remove worktree", () => removeWorktree(w)]] as MenuItem[])),
  ];
}

/** Show worktree `path` in this tab, or switch to the tab that has it; a submodule opened from `parent` too. */
async function openWorktree(path: string, parent = "") {
  const i = tabs.findIndex((t) => t.repo === path);
  if (i >= 0) return switchTab(i);
  if (!(await isRepo(path))) return say(`${path} no longer exists`, true);
  if (!(await dropEdits())) return;
  // the shell ran in the old folder
  dropTerm(tabs[active]);
  tabs[active] = newTab(path, parent);
  await switchTab(active, false);
}

/** `git worktree add` of `branch`, or of a new branch from commit `from`, by default in a folder beside the repository's; this tab stays, the worktree joins the sidebar. */
function createWorktree(branch: string, from = "", busy = "") {
  // a repo tool checkout keeps them out of its tree, where its build would find them: <top>/../wt
  const main = refs.worktrees[0]?.path ?? repo, top = refs.repoTop;
  const beside = (b: string) => `${top ? `${top.slice(0, top.lastIndexOf("/"))}/wt/${basename(main)}` : main}-${b.replace(/\//g, "-")}`;
  if (!from) return dialog(`Create a worktree from ${branch}`, [["Folder", beside(branch)]], "Create", ([path]) => path && gitOp("worktree-add", [path, branch]));
  const name = busy ? `New branch name (${busy} is checked out already, a branch goes in one worktree only)` : "New branch name";
  dialog(`Create a worktree from ${busy || short(from)}`, [[name, ""], ["Folder (empty: beside the repository, named after the branch)", ""]], "Create", ([b, path]) =>
    b && gitOp("worktree-add-new", [path || beside(b), JSON.stringify([b, from])]),
  );
}

/** Back from a worktree or a submodule to its repository, in this tab. */
export async function stepBack() {
  const parent = tabs[active].parent;
  if (!parent || !(await dropEdits())) return;
  dropTerm(tabs[active]);
  tabs[active] = newTab(parent);
  await switchTab(active, false);
}

/** `git worktree remove`, forced after a warning when it has changes; its branch can go too. */
async function removeWorktree(w: Worktree) {
  const s = await invoke<Status>("status", { repo: w.path }).catch(() => null);
  const dirty = !!s && s.staged.length + s.unstaged.length > 0;
  const remove = (andBranch: boolean) => async () => {
    if ((await gitOp(dirty ? "worktree-force-remove" : "worktree-remove", w.path)) && andBranch) deleteBranch(w.branch, "");
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
  selection.stash = null;
  selection.hashes = [hash];
  selection.anchor = hash;
  selection.isRange = false;
  paintSelection();
  showRow(hash, "center");
  renderPanel();
}

function showStash(s: Stash, scroll = false) {
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
  shown = [];
  chunks = [];
  $("rows").replaceChildren();
}

/** Draw the graph from `commits`, at `scroll` when given, before its rows draw: no frame at the old place. */
export function renderGraph(scroll?: number) {
  updateHidden();
  const n = status ? status.staged.length + status.unstaged.length : 0;
  const head = commits.find(isHead);
  const wip = fakeCommit("WIP", head ? [head.hash] : [], "// WIP");
  // an operation in progress keeps the row: its controls live in the WIP panel
  const list = n || opInfo ? [wip, ...commits] : [...commits];
  // a stash hangs off its base commit
  for (const s of refs.stashes) {
    if (hiddenSet.has(s.hash)) continue;
    const at = list.findIndex((c) => c.hash === s.parents[0]);
    if (at >= 0) list.splice(at, 0, fakeCommit(s.hash, [s.parents[0]], s.subject));
  }
  graphLayout = layoutGraph(list);
  // wide enough for its column title
  laneW = Math.max(graphLayout.width * LANE + 10, 64);
  $("graph").style.setProperty("--graph-w", `${laneW}px`);
  shown = list;
  rowColors = list.map((_, i) => laneColor(graphLayout.nodes[i]));
  chunks = Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, k) =>
    h("div", { className: "chunk", style: `height: ${Math.min(CHUNK, list.length - k * CHUNK) * ROW}px` }),
  );
  const tab = tabs[active], more = commits.length >= tab.limit;
  const loadMore = h("button", { className: "load-more", innerHTML: svg(ICONS.down), onclick: () => ((tab.limit += LOG_LIMIT), (loadMore.disabled = true), redraw()) }, "Load more commits");
  $("rows").replaceChildren(...chunks, ...(more ? [loadMore] : []));
  if (scroll !== undefined) $("graph").scrollTop = scroll;
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
  chunks[k].innerHTML = lanesSvg(from, to);
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

function chip(l: Label) {
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
  selection.stash = null;
  const idx = (x: string) => commits.findIndex((c) => c.hash === x);
  if (hash !== "WIP" && e.shiftKey && idx(selection.anchor) >= 0) {
    const [a, b] = [idx(selection.anchor), idx(hash)].sort((x, y) => x - y);
    selection.hashes = commits.slice(a, b + 1).map((c) => c.hash);
    selection.isRange = true;
  } else if (hash !== "WIP" && e.ctrlKey) {
    const s = selection.hashes.filter((x) => x !== "WIP");
    selection.hashes = s.includes(hash) ? s.filter((x) => x !== hash) : [...s, hash];
    if (!selection.hashes.length) selection.hashes = ["WIP"];
    selection.anchor = hash;
    selection.isRange = false;
  } else {
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
      async (ok) => ok && (await gitOp("worktree-prune")) && gitOp("checkout", local),
    );
  const mine = findRef(`refs/heads/${local}`), theirs = findRef(`refs/remotes/${name}`);
  if (!remote || !mine || !theirs || mine.hash === theirs.hash) return gitOp("checkout", local);
  // "[ahead 1, behind 2]" against its upstream
  const track = mine.upstream === name && mine.track ? ` (${mine.track.slice(1, -1)})` : "";
  const drops = /ahead/.test(track) ? `, its commits that are not on ${name} leave the branch` : "";
  dialog(
    `Local ${local} is not at ${name}${track}. Reset it to ${name}${drops}?`,
    [],
    `Reset ${local} to ${name}`,
    () => gitOp("checkout-reset", [local, name]),
    [[`Checkout ${local}`, () => gitOp("checkout", local)]],
  );
}

/** Checkout, merge and rebase for branch `name` (a remote one as "remote/branch"); none for the checked out one. */
function refMenu(name: string, remote: boolean): MenuItem[] {
  const branch = status?.branch || "HEAD", sha = findRef(remote ? `refs/remotes/${name}` : `refs/heads/${name}`)?.hash ?? "";
  if (!remote && name === status?.branch) return [];
  return [
    ["Checkout", () => checkoutBranch(name, remote)],
    [`Merge into ${branch}`, () => gitOp("merge", name)],
    [`Rebase ${branch} onto this branch`, () => gitOp("rebase", name)],
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
  // where the branch lives on a remote: itself, or the local branch's upstream while that still exists
  const up = ref?.upstream ?? "";
  const onRemote = remote ? name : refs.refs.some((r) => r.name === `refs/remotes/${up}`) ? up : "";
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
    ...(remote || current ? [] : ([["Delete", () => deleteBranch(name, onRemote)]] as MenuItem[])),
    // a local branch's upstream too: one menu for both; none of it on the checked out branch
    ...(onRemote && !current
      ? ([[remote ? `Delete on ${rem}` : `Delete ${remBranch} on ${rem}`, () => ask(`Delete branch ${remBranch} on ${rem}? This pushes the deletion.`, "Delete").then((ok) => ok && gitOp("push-delete", [rem, remBranch]))]] as MenuItem[])
      : []),
    ...(current || !ref ? [] : [hideItem(ref.name)]),
    null,
    ["Copy branch name", () => copy(remote ? remBranch : name)],
    ...(rem ? ([[`Copy link to branch on ${rem}`, async () => copy(`${await webUrl(rem)}/tree/${remBranch}`)]] as MenuItem[]) : []),
  ];
}

/** `git branch -d`, or `-D` after saying what is lost when the branch is merged nowhere. */
async function deleteBranch(name: string, upstream: string) {
  const merged = await run<boolean>("is_merged", { branch: name }).catch(() => false);
  if (merged) return (await ask(`Delete branch ${name}?`, "Delete")) && gitOp("branch-delete", name);
  // a squash-merged pull request leaves its branch unmerged here
  const into = upstream || status?.branch || "HEAD";
  if (await ask(`${name} is not merged into ${into}. Delete it with its unmerged commits?`, "Force delete")) gitOp("branch-force-delete", name);
}

function tagMenu(name: string): MenuItem[] {
  // an unanswered remote offers both push and delete
  const known = remoteTags.get(repo) ?? {}, has = (r: string) => known[r]?.includes(name) ?? true, lacks = (r: string) => !known[r]?.includes(name);
  const on = refs.remotes.filter((r) => known[r]?.includes(name)), link = [linkRemote(), ...on].find((r) => on.includes(r));
  return [
    { title: name, icon: ICONS.tag },
    ["Checkout (detached)", () => gitOp("checkout", name)],
    null,
    ...refs.remotes.filter(lacks).map((r): MenuItem => [`Push to ${r}`, () => gitOp("tag-push", [r, name])]),
    ["Rename", () => askName(on.length ? `New tag name, on ${on.join(", ")} too` : "New tag name", name, (n) => n !== name && gitOp("tag-rename", [name, JSON.stringify([n, ...on])]))],
    // no question: the commit stays, and a pushed tag comes back with a fetch
    ["Delete", () => gitOp("tag-delete", name)],
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
