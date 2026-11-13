// The right panel: work in progress or a commit's details, the file lists, the commit box.
import { Change, Commit, commits, fakeCommit, gitOp, headHash, isHead, opInfo, refresh, refs, repo, run, runFixed, selection, status } from "./repo";
import { $, ICONS, MenuItem, ask, avatar, basename, copy, dateFmt, h, ico, input, onCtrlEnter, label, plural, popup, say, shaLink, short, store, svg } from "./ui";
import { DiffSource, confirmDiscard, diffFile, merging, openDiff, openHistory } from "./diff";
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
          ["Discard changes", () => (isSubmodule(f.path) ? discardSubmodule(f.path) : confirmDiscard(f))],
        ] as MenuItem[])
      : []),
    ...(kind === "staged" ? ([["Unstage", () => gitOp("unstage", f.path)]] as MenuItem[]) : []),
    null,
    ...(isSubmodule(f.path) ? ([["Open submodule", () => openSubmodule(f.path)]] as MenuItem[]) : []),
    ["File history", () => openHistory(f.path, c)],
    ["Open in VS Code", () => run("open_in_editor", { path: f.path, line: 1 }).catch(neutral)],
    ["Open in default program", () => run("open_default", { path: f.path, folder: false }).catch(neutral)],
    ["Show in folder", () => run("open_default", { path: f.path, folder: true }).catch(neutral)],
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

/* file lists */

export const isSubmodule = (path: string) => refs.submodules.some((s) => s.path === path);

const CODE_ICON: Record<string, string> = { M: "m", T: "m", A: "a", "?": "a", D: "d", R: "r", C: "r", U: "u" };
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
    const code = CODE_ICON[f.code];
    const row = h(
      "div",
      {
        className: `file${f.code ? "" : " same"}`,
        onclick: () => open(f),
        oncontextmenu: (e: MouseEvent) => popup(e, menu(f)),
        title: f.old ? `${f.old} → ${f.path}` : f.path,
      },
      // a submodule is no file: its own icon, in the colour of its change
      h("span", { className: `code code-${code}`, innerHTML: code ? svg(isSubmodule(f.path) ? ICONS.submodule : ICONS[code]) : "", title: f.code }),
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
  return [avatar(c.author), h("div", {}, c.author, mail, h("small", {}, `authored ${dateFmt.format(c.time * 1000)}`, ...signBadge(c.hash, sign)))];
}

// git's %G? letter of an unsigned commit: said without asking the server
const UNSIGNED = "N";
// the host's verdicts by commit, asked once: "<host> true valid", or "" when gh cannot ask
const verdicts = new Map<string, Promise<string>>();

/** What the remote's host says of signed commit `hash`, through gh. */
function verdict(hash: string) {
  if (!verdicts.has(hash))
    verdicts.set(
      hash,
      (async () => {
        const remote = linkRemote(), m = remote ? (await webUrl(remote)).match(/^https:\/\/([^/]+)\/(.+)$/) : null;
        if (!m) return "";
        return run<string>("gh_verified", { host: m[1], slug: m[2], hash }).then((v) => `${m[1]} ${v}`, () => "");
      })(),
    );
  return verdicts.get(hash)!;
}

/** A pill for the commit's signature: grey while the remote server is asked, then what it says. */
function signBadge(hash: string, sign: string) {
  if (!sign) return [];
  if (sign === UNSIGNED) return [h("span", { className: "sig unsigned", textContent: "Unsigned", title: "Commit isn't signed" })];
  const b = h("span", { className: "sig unknown", textContent: "Verifying", title: "Asking the remote server about the commit signature" });
  verdict(hash).then((v) => {
    const ok = v.split(" ")[1];
    const [cls, text, title] =
      ok === "true" ? ["good", "Verified", "Remote server verified the commit signature"]
      : ok === "false" ? ["warn", "Unverified", "Remote server couldn't verify the commit signature"]
      : ["unknown", "Not checked", "Remote server couldn't be asked about the commit signature"];
    Object.assign(b, { className: `sig ${cls}`, textContent: text, title });
  });
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
export async function renderPanel() {
  const n = ++panelSeq;
  const wip = !selection.stash && selection.hashes[0] === "WIP";
  $("wip").hidden = !wip;
  $("commit").hidden = wip;
  if (wip) return renderWip();
  return renderCommitDetails(n);
}

function renderWip() {
  if (!status) return;
  const n = new Set([...status.unstaged, ...status.staged].map((f) => f.path)).size;
  const conflicts = status.unstaged.filter(isConflict), clean = (f: Change) => !isConflict(f);
  $("wip-title").replaceChildren(...(opInfo ? opTitle() : [`${plural(n, "file change")} on `, h("b", { textContent: status.branch || "detached HEAD" })]));
  $("unstaged-label").textContent = conflicts.length ? "Conflicted Files" : "Unstaged Files";
  $("staged-label").textContent = opInfo ? "Resolved Files" : "Staged Files";
  $("stage-all").textContent = conflicts.length ? "Mark all resolved" : "Stage all changes";
  $("unstaged-n").textContent = `(${status.unstaged.length})`;
  $("staged-n").textContent = `(${status.staged.length})`;
  renderCommitBtn();
  fileList($("unstaged"), [...conflicts, ...status.unstaged.filter(clean)], (f) => openDiff("unstaged", f), [
    ["Mark resolved", (f) => gitOp("stage", f.path), isConflict],
    // no Discard here: a slip next to Stage would cost work; it stays in the menu
    ["Stage", (f) => gitOp("stage", f.path), clean],
  ], (f) => fileMenu(f, "unstaged"));
  fileList($("staged"), status.staged, (f) => openDiff("staged", f), [["Unstage", (f) => gitOp("unstage", f.path)]], (f) => fileMenu(f, "staged"));
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
  if (!open) return;
  const list = open.kind === "commit" ? "commit-files" : open.kind;
  $(list).querySelector(`.file[data-path="${CSS.escape(open.f.path)}"]`)?.classList.add("sel");
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
