// The right panel: work in progress or a commit's details, the file lists, the commit box.
import { Blob, Change, Commit, commits, fakeCommit, gitOp, headHash, isHead, lfsChip, opInfo, openInEditor, refresh, refs, repo, run, runFixed, selection, status } from "./repo";
import { $, ICONS, MenuItem, ask, avatar, basename, copy, dateTimeText, h, ico, input, mod, onCtrlEnter, label, plural, popup, say, shaLink, short, store, svg, warnOnce } from "./ui";
import { DiffSource, closeDiff, confirmDiscard, diffFile, merging, openDiff, openHistory } from "./diff";
import { discardSubmodule, jumpTo, linkRemote, openSubmodule, webUrl } from "./graph";
import { planOpen } from "./rebase";

type Dir = { dirs: Map<string, Dir>; files: Change[] };
export const SORTS: Record<string, string> = { "": "A–Z", desc: "Z–A", status: "Status" };
let panelSeq = 0;
let rewording = "";
let fileQuery = "";
// tree folders start shut; Expand all flips the default, a click flips one folder
let foldersOpen = false;
const foldersFlipped = new Set<string>();
// each file list's files in display order, folded ones included, and how to unfold one
export const fileLists = new Map<HTMLElement, { order: Change[]; reveal: (path: string) => void }>();
type WipList = "unstaged" | "staged";
// files picked with Ctrl or Shift in one WIP list; anchor: where a Shift+click run starts
let picked = { repo: "", list: "unstaged" as WipList, paths: new Set<string>(), anchor: "" };

export const joinMsg = (summary: string, desc: string) => (desc.trim() ? `${summary.trim()}\n\n${desc.trim()}` : summary.trim());

export function splitMsg(msg: string) {
  const nl = msg.indexOf("\n");
  return nl < 0 ? [msg, ""] : [msg.slice(0, nl), msg.slice(nl).trim()];
}

export const getMsg = () => joinMsg(input("summary").value, input("desc").value);

export function setMsg(msg: string) {
  [input("summary").value, input("desc").value] = splitMsg(msg);
  renderCommitBtn();
}

/** Characters left before the 72 column summary limit. */
export function countLeft(summary: HTMLInputElement, out: HTMLElement) {
  const left = 72 - summary.value.length;
  out.textContent = String(left);
  out.classList.toggle("over", left < 0);
}

/** Files in the panels: stage/discard for WIP, restore for a commit, and opening them. */
function fileMenu(f: Change, kind: DiffSource, c?: Commit): MenuItem[] {
  const neutral = (e: unknown) => say(String(e));
  return [
    { title: basename(f.path), icon: ICONS.file },
    ...(kind === "unstaged" && isConflict(f)
      ? ([
          [`Take current (${opInfo?.current ?? "HEAD"})`, () => gitOp("take-current", f.path)],
          [`Take incoming (${opInfo?.incoming ?? "theirs"})`, () => gitOp("take-incoming", f.path)],
          ["Mark resolved", () => gitOp("stage", f.path)],
        ] as MenuItem[])
      : kind === "unstaged"
      ? ([
          ["Stage", () => gitOp("stage", f.path)],
          ["Discard changes", () => (isSubmodule(f.path) ? discardSubmodule(f.path) : confirmDiscard([f]))],
        ] as MenuItem[])
      : []),
    ...(kind === "staged" ? ([["Unstage", () => gitOp("unstage", f.path)]] as MenuItem[]) : []),
    null,
    ...((f.sub ?? isSubmodule(f.path)) ? ([["Open submodule", () => openSubmodule(f.path)]] as MenuItem[]) : []),
    ["File history", () => openHistory(f.path, c)],
    ["Open in editor", () => openInEditor(f.path, 1).catch(neutral)],
    ["Open in default program", () => run("open_default", { path: f.path, folder: false }).catch(neutral)],
    ["Show in folder", () => run("open_default", { path: f.path, folder: true }).catch(neutral)],
    null,
    ...(kind === "commit" ? [] : lfsItems(f)),
    ...(kind === "commit" ? [] : ignoreItems(f)),
    null,
    ...(c
      ? ([
          [
            `Restore file from ${short(c.hash)}`,
            () => ask(`Overwrite ${f.path} in the working tree with its version at ${short(c.hash)}?`, "Overwrite").then((ok) => ok && gitOp("restore-file", [c.hash, f.path])),
          ],
        ] as MenuItem[])
      : // only for work in progress: from a commit's list it would delete today's file, not that commit's
        ([
          [
            "Delete file",
            () => ask(`Delete ${f.path} from the working tree?`, "Delete").then((ok) => (ok ? run("delete_file", { path: f.path }).then(refresh, (e) => say(String(e), true)) : undefined)),
          ],
        ] as MenuItem[])),
    null,
    ["Copy file path", () => copy(`${repo}/${f.path}`)],
  ];
}

/** Track a work file with git-lfs: itself, its extension or its folder; or untrack the pattern that stores it. */
function lfsItems(f: Change): MenuItem[] {
  if (refs.lfsProblem === "missing" || f.code === "D" || isConflict(f) || f.path === ".gitattributes" || isSubmodule(f.path)) return [];
  if (f.lfs) return [["Untrack from LFS", () => untrackLfs(f.path)]];
  const { ext, dir } = extDir(f.path);
  return [
    [
      "Track with LFS",
      [
        ["This file", () => gitOp("lfs-track", [f.path, "file"])],
        ...(ext ? [[`All .${ext} files`, () => gitOp("lfs-track", `*.${ext}`)] as MenuItem] : []),
        ...(dir ? [[`All files in ${dir}`, () => gitOp("lfs-track", `${dir}/**`)] as MenuItem] : []),
      ],
    ],
  ];
}

/** Untrack asks first: the pattern may store many more files than this one. */
async function untrackLfs(path: string) {
  const patterns = await run<string[]>("lfs_patterns", { path }).catch((e) => void say(String(e), true));
  if (!patterns) return;
  if (!patterns.length) return say(`No LFS pattern of the top .gitattributes matches ${path}: the one in its folder does`, true);
  // as git-lfs wrote them: `my[[:space:]]file.png`, `we\[ir\]d.png`
  const list = patterns.map((p) => p.replace(/\[\[:space:\]\]/g, " ").replace(/\\(.)/g, "$1")).join(", ");
  if (await ask(`Stop tracking ${list} with LFS? Its files then show as changed, to commit as plain git files.`, "Untrack")) gitOp("lfs-untrack", patterns.join("\n"));
}

/** A path's extension (none for a dotfile) and folder, for the menus acting on all files alike. */
function extDir(path: string) {
  const name = basename(path), ext = name.slice(name.lastIndexOf(".") + 1 || name.length);
  return { ext: ext === name.slice(1) ? "" : ext, dir: path.slice(0, -name.length - 1) };
}

// a .gitignore pattern for `path` alone, from the top folder
const anchored = (path: string) => `/${path.replace(/[*?[\\]/g, "\\$&")}`;

/** Ignore a work file: itself, its extension or its folder. */
function ignoreItems(f: Change): MenuItem[] {
  if (isConflict(f) || isSubmodule(f.path)) return [];
  const { ext, dir } = extDir(f.path);
  return [
    [
      "Ignore",
      [
        ["This file", () => ignore([anchored(f.path)], [f])],
        ...(ext ? [[`All .${ext} files`, () => ignore([`*.${ext}`], [f])] as MenuItem] : []),
        dir ? [`All files in ${dir}`, () => ignore([`${anchored(dir)}/`], [f])] : ["All files in its folder", null, "Cannot ignore the root folder"],
      ],
    ],
  ];
}

/** Add `patterns` to the top .gitignore, in its line endings; the tracked `files` leave the index, kept on disk. */
async function ignore(patterns: string[], files: Change[]) {
  try {
    const b = await run<Blob>("blob", { at: "WORKTREE", path: ".gitignore" });
    // its first part only: written back, the rest would be lost
    if (b.large || b.binary) throw ".gitignore is too big to edit here";
    const text = b.exists ? b.text : "", eol = text.includes("\r\n") ? "\r\n" : "\n";
    await run("write_file", { path: ".gitignore", text: text + (text && !text.endsWith("\n") ? eol : "") + patterns.map((p) => p + eol).join("") });
    say(`ignored ${patterns.join(", ")}`);
    // a pattern does not untrack: their removal is staged
    const tracked = files.filter((f) => f.code !== "?");
    if (tracked.length) return void (await gitOp("untrack", pathArg(tracked)));
  } catch (e) {
    say(String(e), true);
  }
  refresh();
}

// the file ops' paths, NUL separated
export const pathArg = (files: Change[]) => files.map((f) => f.path).join("\0");

/** The files picked in `list`, when two or more. */
export const pickedFiles = (list: WipList) => (picked.repo === repo && picked.list === list && picked.paths.size > 1 ? status?.[list].filter((f) => picked.paths.has(f.path)) : undefined);

/** Click opens a file's diff; Ctrl+click picks files of one list, Shift+click a run of them: two or more close the diff. */
function clickFile(list: WipList, f: Change, e: MouseEvent) {
  const mine = picked.repo === repo && picked.list === list;
  if (!mod(e) && !e.shiftKey) {
    picked = { repo, list, paths: new Set([f.path]), anchor: f.path };
    return openDiff(list, f);
  }
  const paths = new Set(mine ? picked.paths : []), anchor = mine ? picked.anchor : f.path;
  if (e.shiftKey) {
    // the rows shown: a folded folder's files stay out
    const order = [...$(list).querySelectorAll<HTMLElement>(".file")].map((r) => r.dataset.path!);
    const [a, b] = [order.indexOf(anchor), order.indexOf(f.path)].sort((x, y) => x - y);
    paths.clear();
    order.slice(Math.max(a, 0), b + 1).forEach((p) => paths.add(p));
  } else if (!paths.delete(f.path)) paths.add(f.path);
  picked = { repo, list, paths, anchor: e.shiftKey ? anchor : f.path };
  const [one] = paths;
  if (paths.size === 1) return openDiff(list, status![list].find((x) => x.path === one)!);
  closeDiff().then(markOpenFile);
}

/** What two or more picked files can do together. */
// git refuses a whole checkout over one conflict; a submodule has a discard of its own
export const cannotDiscard = (files: Change[]) => (files.some((f) => isConflict(f) || isSubmodule(f.path)) ? "Conflicted files and submodules are discarded one at a time" : "");

function pickedMenu(list: WipList, files: Change[]): MenuItem[] {
  const n = plural(files.length, "file"), paths = pathArg(files), why = cannotDiscard(files);
  return [
    { title: n, icon: ICONS.file },
    ...((list === "unstaged"
      ? [
          [`Stage ${n}`, () => gitOp("stage", paths)],
          [`Discard ${n}`, why ? null : () => confirmDiscard(files), why],
        ]
      : [
          [`Unstage ${n}`, () => gitOp("unstage", paths)],
          [`Discard ${n}`, why ? null : () => confirmDiscard(files, true), why],
        ]) as MenuItem[]),
    [`Stash ${n}`, () => gitOp("stash-files", paths)],
    [`Ignore ${n}`, () => ignore(files.map((f) => anchored(f.path)), files)],
  ];
}

const wipMenu = (list: WipList) => (f: Change) => {
  const files = pickedFiles(list);
  return files?.some((x) => x.path === f.path) ? pickedMenu(list, files) : fileMenu(f, list);
};

/* file lists */

export const isSubmodule = (path: string) => refs.submodules.some((s) => s.path === path);

const CODE_ICON: Record<string, string> = { M: "m", T: "m", A: "a", "?": "a", D: "d", R: "r", C: "r", U: "u" };
const STATUS_ORDER = "U?AMTRCD";

function fileList(
  el: HTMLElement,
  files: Change[],
  open: (f: Change, e: MouseEvent) => void,
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
    const code = CODE_ICON[f.code];
    const row = h(
      "div",
      {
        className: `file${f.code ? "" : " same"}`,
        onclick: (e: MouseEvent) => open(f, e),
        oncontextmenu: (e: MouseEvent) => popup(e, menu(f)),
        title: f.old ? `${f.old} → ${f.path}` : f.path,
      },
      // a submodule is no file: its own icon, in the colour of its change
      h("span", { className: `code code-${code}`, innerHTML: code ? svg((f.sub ?? isSubmodule(f.path)) ? ICONS.submodule : ICONS[code]) : "", title: f.code }),
      // before the name: at the end the row's buttons cover it
      ...(f.lfs ? [lfsChip()] : []),
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
        const path = prefix + name, shut = foldersOpen === foldersFlipped.has(path);
        if (shown) {
          const toggle = () => (foldersFlipped.has(path) ? foldersFlipped.delete(path) : foldersFlipped.add(path), draw());
          const folder = h("div", { className: "folder", onclick: toggle, title: path }, h("span", { className: "twisty", textContent: shut ? "▸" : "▾" }), ico(shut ? ICONS.folder : ICONS.folderOpen), name);
          if (shut) folder.append(...fileCounts(filesUnder(sub)));
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
    const shut = (routes.get(path) ?? []).filter((p) => foldersOpen === foldersFlipped.has(p));
    if (!shut.length) return;
    shut.forEach((p) => (foldersOpen ? foldersFlipped.delete(p) : foldersFlipped.add(p)));
    draw();
  };
  fileLists.set(el, { order, reveal });
  draw();
}

/** Filter the file lists by `text`; both filter boxes show it. */
export function filterFiles(text: string) {
  fileQuery = text.trim().toLowerCase();
  document.querySelectorAll<HTMLInputElement>(".file-filter").forEach((o) => (o.value = text));
  renderPanel();
}

/** Open or shut every folder of the file trees. */
export function foldAll(open: boolean) {
  foldersOpen = open;
  foldersFlipped.clear();
  renderPanel();
}

const filesUnder = (d: Dir): Change[] => [...d.files, ...[...d.dirs.values()].flatMap(filesUnder)];

/** Every changed file once, staged or not. */
export const wipFiles = () => [...new Map([...(status?.staged ?? []), ...(status?.unstaged ?? [])].map((f) => [f.path, f])).values()];

/** Per-kind counts with their icons, like "✎ 3 + 1". */
export function fileCounts(files: Change[]) {
  return ["m", "a", "d", "r", "u"].flatMap((cls) => {
    const n = files.filter((f) => CODE_ICON[f.code] === cls).length;
    return n ? [h("span", { className: `count code-${cls}`, innerHTML: `${svg(ICONS[cls])}${n}` })] : [];
  });
}

export function paintFileOpts() {
  const view = store("files-view") || "path";
  document.querySelectorAll<HTMLElement>("[data-files]").forEach((b) => b.classList.toggle("on", b.dataset.files === view));
  document.querySelectorAll<HTMLElement>(".tree-all").forEach((b) => {
    const what = b.dataset.open ? "Expand all folders" : "Collapse all folders";
    b.classList.toggle("off", view !== "tree");
    b.title = view === "tree" ? what : `${what}: only in Tree view`;
  });
  // every label in the button, the others invisible: it keeps the widest one's width
  const sort = store("files-sort") ?? "";
  document.querySelectorAll<HTMLElement>(".files-opts .sort").forEach((b) =>
    b.replaceChildren(...Object.entries(SORTS).map(([k, label]) => h("span", { className: k === sort ? "" : "ghost", textContent: label }))),
  );
}

/** What the commit panel shows: one commit, a stash, a compare or a range as one pseudo commit. */
function panelCommit(): { c: Commit; message?: string; head: (Node | string)[]; author?: Commit } | null {
  if (selection.stash) {
    const s = selection.stash;
    const c = fakeCommit(s.hash, s.parents.slice(0, 1), s.subject);
    return { c, message: s.subject, head: ["stash ", shaLink(s.hash), " · on ", shaLink(s.parents[0] ?? "")] };
  }
  const sel = commits.filter((c) => selection.hashes.includes(c.hash));
  if (!sel.length) return null;
  const newest = sel[0], oldest = sel[sel.length - 1];
  if (sel.length === 1) {
    const parents = newest.parents.flatMap((p, i) => (i ? [" + ", shaLink(p)] : [" · parent ", shaLink(p)]));
    return { c: newest, head: ["commit ", shaLink(newest.hash), ...parents], author: newest };
  }
  // a range diffs from before its oldest commit, a Ctrl pick compares the two ends
  const base = selection.isRange ? (oldest.parents[0] ?? "") : oldest.hash;
  const list = sel.map((c) => `${short(c.hash)}  ${c.subject}`).join("\n");
  return {
    c: { ...newest, parents: base ? [base] : [] },
    message: selection.isRange ? `${sel.length} commits\n${list}` : `Compare ${short(oldest.hash)} → ${short(newest.hash)}\n${list}`,
    head: [selection.isRange ? "range " : "compare ", base ? shaLink(base) : "root", "..", shaLink(newest.hash)],
  };
}

function authorBlock(c: Commit, email: string, sign: string) {
  const mail = h("small", { className: "email", textContent: email, title: `Copy ${email}`, onclick: () => copy(email) });
  return [avatar(c.author), h("div", {}, c.author, mail, h("small", {}, `authored ${dateTimeText(c.time)}`, ...signBadge(c.hash, sign)))];
}

// git's %G? letter of an unsigned commit: said without asking the server
const UNSIGNED = "N";
// the host's verdicts by commit: "<host> true valid" kept, a GH_HELP key or "" (not pushed yet, offline) asked again next time
const verdicts = new Map<string, Promise<string>>();
const GH_HELP: Record<string, string> = {
  "gh-missing": "Install the GitHub CLI (gh) to have the remote server verify commit signatures.",
  "gh-auth": "Sign in to the GitHub CLI (`gh auth login`) to have the remote server verify commit signatures.",
};

/** What the remote's host says of signed commit `hash`, through gh. */
function verdict(hash: string) {
  if (!verdicts.has(hash))
    verdicts.set(
      hash,
      (async () => {
        const remote = linkRemote(), m = remote ? (await webUrl(remote).catch(() => "")).match(/^https:\/\/([^/]+)\/(.+)$/) : null;
        if (!m) return "";
        return run<string>("gh_verified", { host: m[1], slug: m[2], hash }).then(
          (v) => `${m[1]} ${v}`,
          (e) => (GH_HELP[String(e)] ? (warnOnce(String(e), "Signatures not checked", GH_HELP[String(e)], "info"), String(e)) : ""),
        );
      })().then((v) => (v.split(" ")[1] ? v : (verdicts.delete(hash), v))),
    );
  return verdicts.get(hash)!;
}

/** A pill for the commit's signature: grey while the remote server is asked, then what it says. */
function signBadge(hash: string, sign: string) {
  if (!sign) return [];
  if (sign === UNSIGNED) return [h("span", { className: "sig unsigned", textContent: "Unsigned", title: "Commit isn't signed" })];
  const b = h("span", { className: "sig unknown", textContent: "Verifying", title: "Asking the remote server about the commit signature" });
  const paint = (v: string) => {
    const ok = v.split(" ")[1];
    const [cls, text, title] =
      ok === "true" ? ["good", "Verified", "Remote server verified the commit signature"]
      : ok === "false" ? ["warn", "Unverified", "Remote server couldn't verify the commit signature"]
      : ["unknown", "Not checked", GH_HELP[v] ?? "Remote server couldn't be asked about the commit signature"];
    Object.assign(b, { className: `sig ${cls}`, textContent: text, title });
  };
  if (verdicts.has(hash)) verdict(hash).then(paint);
  // arrowing through the graph asks only where it stops
  else setTimeout(() => b.isConnected && verdict(hash).then(paint), 300);
  return [b];
}

function fileStats(files: Change[]) {
  const kinds: [string, string, string][] = [["MT", "modified", "m"], ["A", "added", "a"], ["D", "deleted", "d"], ["RC", "renamed", "r"]];
  return kinds.flatMap(([codes, label, cls]) => {
    const n = files.filter((f) => codes.includes(f.code)).length;
    return n ? [h("span", { className: `code-${cls}`, innerHTML: `${svg(ICONS[cls])} ${n} ${label}` })] : [];
  });
}

/** Swap the HEAD commit's message for an editor that rewrites it in place. */
function editMessage(c: Commit, msg: string) {
  if (!isHead(c)) return say("only the checked out commit can be reworded", true);
  rewording = c.hash;
  $("commit-msg").ondblclick = null;
  const [s, d] = splitMsg(msg);
  const summary = h("input", { className: "msg-in", value: s, spellcheck: false });
  const desc = h("textarea", { className: "msg-in", value: d, spellcheck: false, placeholder: "Description" });
  const left = h("small");
  const cancel = () => ((rewording = ""), renderPanel());
  const update = async () => {
    const m = joinMsg(summary.value, desc.value);
    if (!m) return say("empty commit message", true);
    if (await gitOp("reword", m)) jumpTo(headHash());
  };
  summary.oninput = () => countLeft(summary, left);
  countLeft(summary, left);
  onCtrlEnter([summary, desc], update);
  $("commit-msg").classList.add("editing");
  $("commit-msg").replaceChildren(
    h("div", { className: "summary" }, summary, left),
    desc,
    h("div", { className: "edit-btns" }, h("button", { innerHTML: svg(ICONS.close), onclick: cancel }, "Cancel"), h("button", { className: "primary", innerHTML: svg(ICONS.check), onclick: update }, "Update message")),
  );
  summary.focus();
}

/** The right panel: the work in progress, or the picked commit, range or stash. */
/** What the commit panel reads, read ahead: a tab switch then lands with its panel. */
export function panelData() {
  const view = !selection.stash && selection.hashes[0] === "WIP" ? null : panelCommit();
  if (!view) return Promise.resolve();
  const all = $("all-files").classList.contains("on") ? [runFixed("tree_files", { at: view.c.hash })] : [];
  return Promise.all([runFixed("commit_info", { hash: view.c.hash, parent: view.c.parents[0] ?? "" }), ...all]).catch(() => {});
}

export async function renderPanel() {
  const n = ++panelSeq;
  const wip = !selection.stash && selection.hashes[0] === "WIP";
  $("wip").hidden = !wip;
  $("commit").hidden = wip;
  if (wip) return renderWip();
  picked.paths.clear();
  return renderCommitDetails(n);
}

function renderWip() {
  if (!status) return;
  const n = new Set([...status.unstaged, ...status.staged].map((f) => f.path)).size;
  const conflicts = status.unstaged.filter(isConflict), clean = (f: Change) => !isConflict(f);
  $("wip-title").replaceChildren(...(opInfo ? opTitle() : [`${plural(n, "file change")} on `, h("b", { textContent: status.branch || "detached HEAD" })]));
  $("unstaged-label").textContent = conflicts.length ? "Conflicted Files" : "Unstaged Files";
  $("staged-label").textContent = opInfo ? "Resolved Files" : "Staged Files";
  $("unstaged-n").textContent = `(${status.unstaged.length})`;
  $("staged-n").textContent = `(${status.staged.length})`;
  renderCommitBtn();
  // a pick's files that left its list
  picked.paths = new Set([...picked.paths].filter((p) => status![picked.list].some((f) => f.path === p)));
  fileList($("unstaged"), [...conflicts, ...status.unstaged.filter(clean)], (f, e) => clickFile("unstaged", f, e), [
    ["Mark resolved", (f) => gitOp("stage", f.path), isConflict],
    // no Discard here: a slip next to Stage would cost work; it stays in the menu
    ["Stage", (f) => gitOp("stage", f.path), clean],
  ], wipMenu("unstaged"));
  fileList($("staged"), status.staged, (f, e) => clickFile("staged", f, e), [["Unstage", (f) => gitOp("unstage", f.path)]], wipMenu("staged"));
  markOpenFile();
}

/** A commit's, range's or stash's message, author and files; `n` is the panel paint it belongs to. */
async function renderCommitDetails(n: number) {
  const view = panelCommit();
  if (!view) return;
  try {
    const info = await runFixed<{ message: string; email: string; sign: string; files: Change[] }>("commit_info", { hash: view.c.hash, parent: view.c.parents[0] ?? "" });
    if (n !== panelSeq) return;
    const all = $("all-files").classList.contains("on") ? await runFixed<string[]>("tree_files", { at: view.c.hash }) : [];
    if (n !== panelSeq) return;
    const msg = view.message ?? info.message;
    $("commit-head").replaceChildren(...view.head);
    if (rewording !== view.c.hash) {
      rewording = "";
      const [summary, desc] = splitMsg(msg);
      // the open rebase plan owns the messages until it runs: Edit stays, greyed
      const locked = planOpen(), reword = view.author && isHead(view.c) ? () => editMessage(view.c, msg) : null;
      $("commit-msg").classList.remove("editing");
      $("commit-msg").replaceChildren(
        h("div", { id: "commit-summary", textContent: summary }),
        h("div", { id: "commit-desc", textContent: desc }),
        ...(reword ? [h("button", { className: `edit${locked ? " off" : ""}`, innerHTML: svg(ICONS.m), title: locked ? "Close the interactive rebase to edit here" : "Reword (double-click)", onclick: reword }, "Edit")] : []),
      );
      $("commit-msg").ondblclick = locked ? null : reword;
    }
    $("commit-author").replaceChildren(...(view.author ? authorBlock(view.author, info.email, info.sign) : []));
    $("commit-stats").replaceChildren(...fileStats(info.files));
    // all files: the commit's tree, with the changed ones marked
    const changed = new Map(info.files.map((f) => [f.path, f]));
    const files = all.length ? [...new Set([...all, ...changed.keys()])].sort().map((p) => changed.get(p) ?? { path: p, old: null, code: "" }) : info.files;
    fileList($("commit-files"), files, (f) => openDiff("commit", f, view.c), [], (f) => fileMenu(f, "commit", view.c));
  } catch (e) {
    say(String(e), true);
  }
  markOpenFile();
}

/** The file open in the diff or the merge tool. */
export const openFile = () => diffFile ?? (merging ? { kind: "unstaged" as DiffSource, f: merging.f } : null);

export function markOpenFile() {
  document.querySelectorAll(".file.sel").forEach((r) => r.classList.remove("sel"));
  const open = openFile();
  // a diff opened in a list, by click or arrow key, ends its pick
  if (open && open.kind === picked.list) picked.paths = new Set([open.f.path]);
  // the head's buttons act on the pick
  const unstaged = pickedFiles("unstaged"), staged = pickedFiles("staged"), n = (unstaged ?? staged)?.length ?? 0, why = cannotDiscard(unstaged ?? staged ?? []);
  ($("discard-all") as HTMLButtonElement).disabled = !!why;
  $("discard-all").title = why || (n ? `Discard ${plural(n, "file")}` : "Discard all changes");
  $("discard-n").textContent = n ? String(n) : "";
  $("stage-all").textContent = unstaged ? `Stage ${plural(unstaged.length, "file")}` : conflictCount() ? "Mark all resolved" : "Stage all changes";
  $("unstage-all").textContent = staged ? `Unstage ${plural(staged.length, "file")}` : "Unstage all changes";
  const mark = (list: string, path: string) => $(list).querySelector(`.file[data-path="${CSS.escape(path)}"]`)?.classList.add("sel");
  for (const list of ["unstaged", "staged"] as const) pickedFiles(list)?.forEach((f) => mark(list, f.path));
  if (open) mark(open.kind === "commit" ? "commit-files" : open.kind, open.f.path);
}

export const isConflict = (f: Change) => f.code === "U";
// a rebase or cherry-pick step whose changes are all already there
export const emptyStep = () => !!opInfo && opInfo.state !== "merge" && !status?.staged.length && !status?.unstaged.length;
export const conflictCount = () => status?.unstaged.filter(isConflict).length ?? 0;

/** "Rebasing feature onto main" for the operation in progress. */
export function opLine(): (Node | string)[] {
  const o = opInfo!, verb = { rebase: "Rebasing", merge: "Merging", "cherry-pick": "Cherry-picking", revert: "Reverting" }[o.state] ?? o.state;
  return [`${verb} `, h("b", { textContent: o.incoming }), ` ${o.state === "merge" ? "into" : "onto"} `, h("b", { textContent: o.current })];
}

const opTitle = () => [...opLine(), ...(opInfo!.step ? [` · commit ${opInfo!.step.replace("/", " of ")}`] : [])];

/** The WIP row while files are in conflict: an orange bar. */
export function conflictLine(): (Node | string)[] {
  const k = conflictCount();
  return [ico(ICONS.error), `${plural(k, "file conflict")} · `, ...opLine()];
}

export const amending = () => $("amend").classList.contains("on");

export function renderCommitBtn() {
  const amend = amending(), staged = status?.staged.length ?? 0;
  const b = $("commit-btn") as HTMLButtonElement;
  countLeft(input("summary"), $("summary-n"));
  // an operation in progress commits through its Continue
  b.hidden = $("amend").hidden = !!opInfo;
  $("op-btns").hidden = !opInfo;
  if (opInfo) {
    const left = conflictCount(), c = $("op-continue");
    label(c, ICONS.check, opInfo.state === "merge" ? "Commit and merge" : "Continue");
    c.classList.toggle("off", left > 0);
    c.title = left ? `Resolve the ${plural(left, "conflicted file")} first` : emptyStep() ? "Nothing left to commit in this step: Continue skips it" : "";
    $("op-skip").hidden = opInfo.state === "merge";
  }
  b.disabled = !input("summary").value.trim() || (!staged && !amend);
  label(
    b,
    amend ? ICONS.m : ICONS.commit,
    amend ? "Amend previous commit" : !staged ? "Stage files to commit" : b.disabled ? "Type a summary to commit" : `Commit changes to ${plural(staged, "file")}`,
  );
}

export async function commit() {
  const amend = amending();
  if (($("commit-btn") as HTMLButtonElement).disabled) return;
  if (await gitOp(amend ? "amend" : "commit", getMsg())) {
    $("amend").classList.remove("on");
    setMsg("");
  }
}
