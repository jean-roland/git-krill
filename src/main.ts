// Entry: wires the buttons and keys to the features, then reopens the tabs.
import { invoke } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";
import { Mode, closeDiff, closeHistory, closeMerge, diffEditor, diffFile, editor, goConflict, hist, histEd, histView, loadMerge, loadMonaco, merging, openHistory, paintBlame, paintBlameBtn, pickAll, relayout, save, saveMerge, setMode, showRev, warmDiff } from "./diff";
import { rebaseKey } from "./rebase";
import { SORTS, amending, commit, conflictCount, emptyStep, fileLists, filterFiles, foldAll, getMsg, openFile, paintFileOpts, renderCommitBtn, renderPanel, setMsg } from "./panel";
import { $, ask, closeDialog, hideBanner, input, onCtrlEnter, pickDir, popup, say, store } from "./ui";
import { closeFind, drawRows, findStep, findTyped, stepBack, openFind, paintSelection, showRow, shown } from "./graph";
import { Change, active, addTab, autoFetch, cloneDialog, closeTab, gitOp, opInfo, newTabMenu, openPicked, openRepo, paintPull, pull, pullMenu, push, refresh, renderTabHits, reopenTab, repo, restoreTabs, run, selection, switchTab, tabs, undoRedo } from "./repo";
import { terms, toggleTerm } from "./terminal";

/** Up/Down walk the graph, or the files once Right opened one; Left goes back to the graph. */
function arrow(key: string) {
  if (hist) return key === "ArrowUp" || key === "ArrowDown" ? showRev(hist.at + (key === "ArrowDown" ? 1 : -1)) : undefined;
  if (key === "ArrowLeft") return closeDiff();
  const down = key === "ArrowDown";
  const inFiles = !!openFile();
  // every file of the visible lists, folded folders included: moving onto one unfolds it
  const files = ["unstaged", "staged", "commit-files"]
    .filter((id) => $(id).offsetParent)
    .flatMap((id) => (fileLists.get($(id))?.order ?? []).map((f) => ({ id, f })));
  if (key === "ArrowRight") return inFiles || (files[0] && openListed(files[0].id, files[0].f));
  if (inFiles) {
    const open = openFile()!, id = open.kind === "commit" ? "commit-files" : open.kind;
    const next = files[files.findIndex((x) => x.id === id && x.f.path === open.f.path) + (down ? 1 : -1)];
    return next && openListed(next.id, next.f);
  }
  const i = shown.findIndex((c) => c.hash === selection.anchor);
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

document.querySelectorAll<HTMLElement>("[data-op]").forEach((b) => (b.onclick = () => (b.dataset.op === "push" ? push() : b.dataset.op === "pull" ? pull() : gitOp(b.dataset.op!))));
$("pull-mode").onclick = pullMenu;
paintPull();
addEventListener("focus", () => autoFetch());
setInterval(() => autoFetch(), 5 * 60_000);
document.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => (b.onclick = () => setMode(b.dataset.mode as Mode)));
$("new-tab").onclick = addTab;
$("new-tab").oncontextmenu = (e) => popup(e, newTabMenu());
// past their narrowest, tabs scroll sideways under the wheel
$("tablist").onwheel = (e) => ($("tablist").scrollLeft += e.deltaY + e.deltaX);
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
$("find-q").oninput = findTyped;
$("find-q").onkeydown = (e) => {
  if (e.key === "Enter") findStep(e.shiftKey ? -1 : 1);
};
$("find-prev").onclick = () => findStep(-1);
$("find-next").onclick = () => findStep(1);
$("find-close").onclick = closeFind;
document.querySelectorAll<HTMLInputElement>(".file-filter").forEach((f) => (f.oninput = () => filterFiles(f.value)));
$("stage-all").onclick = () => gitOp(conflictCount() ? "resolve-all" : "stage-all");
$("op-continue").onclick = () => {
  // git refuses to continue an empty step and says to skip it
  if (emptyStep()) return gitOp("skip");
  // a rebase step keeps its own message unless reworded
  const msg = getMsg().trim(), keep = opInfo?.state !== "merge" && msg === opInfo?.message.trim();
  gitOp("continue", keep ? "" : msg);
};
$("op-skip").onclick = () => gitOp("skip");
$("op-abort").onclick = () => ask(`Abort the ${opInfo?.state}? What it did so far is dropped.`, "Abort").then((ok) => ok && gitOp("abort"));
$("opstate").onclick = () => {
  selection.stash = null;
  selection.hashes = [(selection.anchor = "WIP")];
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
  ask("Discard ALL changes: staged, unstaged and untracked files? This cannot be undone.", "Discard all").then((ok) => ok && gitOp("discard-all"));
$("unstage-all").onclick = () => gitOp("unstage-all");
$("commit-btn").onclick = commit;
onCtrlEnter([$("summary"), $("desc")], commit);
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
$("undo").onclick = () => undoRedo(true);
$("redo").onclick = () => undoRedo(false);
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
document.querySelectorAll<HTMLElement>(".tree-all").forEach((b) => (b.onclick = () => foldAll(!!b.dataset.open)));
paintFileOpts();
resizer($("term-grip"), $("term"), "term-height", (m) =>
  Math.min($("center").clientHeight - 120, Math.max(80, $("term").getBoundingClientRect().bottom - m.clientY)),
);
resizer($("commit-grip"), $("commit-msg"), "msg-height", (m) => Math.min(innerHeight * 0.6, Math.max(60, m.clientY - $("commit-msg").getBoundingClientRect().top)));
export const main = document.querySelector("main")!;
resizer($("sidebar-grip"), main, "sidebar-width", (m) => Math.min(480, Math.max(160, m.clientX)), "--sidebar-w");
resizer($("details-grip"), main, "details-width", (m) => Math.min(innerWidth * 0.5, Math.max(300, innerWidth - m.clientX)), "--details-w");
new ResizeObserver(() => terms.get(tabs[active])?.fit.fit()).observe($("term"));
$("diff-close").onclick = () => closeDiff();
$("diff-history").onclick = () => diffFile && openHistory(diffFile.f.path, diffFile.c);
$("hist-close").onclick = () => closeHistory();
document.querySelectorAll<HTMLElement>("[data-hview]").forEach((b) => (b.onclick = () => histView(b.dataset.hview!)));
histView(store("hist-view") ?? "file");
resizer($("hist-grip"), $("hist"), "hist-width", (m) => Math.min(innerWidth * 0.6, Math.max(220, m.clientX - $("hist").getBoundingClientRect().left)), "--hist-list-w");
$("hist-blame").onclick = () => {
  if (store("hist-view") === "diff") return;
  store("hist-blame", store("hist-blame") === "on" ? "off" : "on");
  paintBlameBtn();
  if (hist && histEd?.getModel()) paintBlame();
};
$("prev-change").onclick = () => diffFile && editor().goToDiff("previous");
$("next-change").onclick = () => diffFile && editor().goToDiff("next");
$("open-editor").onclick = () => {
  if (!diffFile) return;
  const line = editor().getModifiedEditor().getPosition()?.lineNumber ?? 1;
  run("open_in_editor", { path: diffFile.f.path, line }).catch((e) => say(String(e), true));
};
$("diff-save").onclick = () => save().then(refresh);
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
addEventListener("contextmenu", (e) => !(e.target as HTMLElement).closest("input, textarea, #diff-editor") && e.preventDefault());
addEventListener("keydown", (e) => {
  const key = e.key.toLowerCase();
  if (e.ctrlKey && e.code === "Backquote") (e.preventDefault(), toggleTerm());
  // GTK turns Shift+Tab into ISO_Left_Tab: the physical key is the sure one
  else if (e.ctrlKey && e.code === "Tab") (e.preventDefault(), switchTab((active + (e.shiftKey ? tabs.length - 1 : 1)) % tabs.length));
  // the shell owns every other key
  else if ((e.target as HTMLElement).closest?.("#term")) return;
  // back from a worktree or a submodule to its repository, from anywhere but the shell
  else if (e.altKey && e.key === "ArrowLeft" && tabs[active].parent) (e.preventDefault(), stepBack());
  // the rebase plan's keys, unless a dialog, a menu, a diff over it or a field has them
  else if ($("dialog").hidden && $("menu").hidden && $("diff").hidden && !(e.target as HTMLElement).closest?.("select, input, textarea") && rebaseKey(e)) e.preventDefault();
  else if (e.key === "F5") (e.preventDefault(), refresh());
  else if (e.ctrlKey && e.shiftKey && key === "t") (e.preventDefault(), reopenTab());
  else if (e.ctrlKey && key === "t") (e.preventDefault(), addTab());
  else if (e.ctrlKey && key === "o") (e.preventDefault(), openPicked());
  else if (e.ctrlKey && key === "w") (e.preventDefault(), closeTab(active));
  else if (e.key === "Escape") {
    if (!$("menu").hidden) $("menu").hidden = $("submenu").hidden = true;
    else if (!$("banner").hidden) hideBanner();
    else if (!$("dialog").hidden) closeDialog();
    else if (!$("tab-search").hidden) $("tab-search").hidden = true;
    else if (!$("find").hidden && !openFile()) closeFind();
    else if (hist) closeHistory();
    else if (!$("diff").hidden) closeDiff();
    else if (merging) closeMerge();
    // nothing left open: the graph itself steps back out of a worktree or a submodule
    else if (tabs[active].parent && !(e.target as HTMLElement).closest?.("input, textarea")) stepBack();
  } else if ((e.target as HTMLElement).closest?.("input:not([type=checkbox]), textarea, #diff-editor, #merge, #hist-file") || !repo) return;
  else if (e.ctrlKey && key === "f") (e.preventDefault(), openFind());
  else if (e.ctrlKey && key === "z") (e.preventDefault(), undoRedo(!e.shiftKey));
  else if (e.ctrlKey && key === "y") (e.preventDefault(), undoRedo(false));
  else if (e.key.startsWith("Arrow") && !e.ctrlKey && !e.altKey && !e.shiftKey) (e.preventDefault(), arrow(e.key));
});

// warm Monaco and its diff worker up front: a cold first diff took ~0.5 s
setTimeout(async () => {
  await loadMonaco();
  if (!diffEditor) warmDiff();
}, 1000);

restoreTabs();
