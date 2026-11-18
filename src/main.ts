// Entry: wires the buttons and keys to the features, then reopens the tabs.
import { invoke } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";
import { Mode, closeDiff, closeHistory, confirmDiscard, closeMerge, diffEditor, diffFile, editor, fitImages, goConflict, hist, histEd, histView, loadMerge, loadMonaco, merging, nextChange, openDiffFile, openHistory, paintBlame, paintBlameBtn, pickAll, relayout, save, saveMerge, setFontSize, setMode, setWordWrap, setSvgView, showRev, warmDiff } from "./diff";
import { rebaseKey } from "./rebase";
import { SORTS, amending, commit, conflictCount, emptyStep, fileLists, filterFiles, foldAll, getMsg, openFile, paintFileOpts, pathArg, pickedFiles, renderCommitBtn, renderPanel, setMsg } from "./panel";
import { $, ICONS, ask, closeDialog, dismissToast, hideBanner, input, mod, onCtrlEnter, pickDir, popup, say, store, svg, warnOnce } from "./ui";
import { closeFind, drawRows, findStep, findTyped, stepBack, laneBarScrolled, openFind, paintSelection, scrollLanes, showRow, shown, wheelLanes } from "./graph";
import { Change, active, addTab, autoFetch, cloneDialog, closeTab, fetchMinutes, gitOp, opInfo, newTabMenu, openPicked, openRepo, openSettings, paintPull, pull, pullMenu, push, refresh, renderTabHits, reopenTab, repo, restoreTabs, run, selection, switchTab, tabs, undoMenu, undoRedo } from "./repo";
import { checkTools } from "./settings";
import { terms, toggleTerm } from "./terminal";
import { closePr, followPrLink, loadPrs } from "./pr";

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
  // the graph is under a pull request's page
  if (!$("pr").hidden) return;
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
function resizer(grip: HTMLElement, box: HTMLElement, key: string, size: (m: PointerEvent) => number, prop = "height", unit = "px") {
  box.style.setProperty(prop, store(key) ?? "");
  grip.onpointerdown = (e) => {
    // else the drag selects the text it crosses
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add("drag");
    grip.onpointermove = (m) => {
      box.style.setProperty(prop, `${size(m)}${unit}`);
      relayout();
    };
    grip.onpointerup = () => {
      grip.onpointermove = null;
      grip.classList.remove("drag");
      store(key, box.style.getPropertyValue(prop));
    };
  };
  // back to the default size
  grip.ondblclick = () => (box.style.removeProperty(prop), store(key, ""), relayout());
}

/* wiring */

document.querySelectorAll<HTMLElement>("[data-op]").forEach((b) => (b.onclick = () => (b.dataset.op === "push" ? push() : b.dataset.op === "pull" ? pull() : gitOp(b.dataset.op!))));
$("pull-mode").onclick = pullMenu;
$("pull").oncontextmenu = (e) => (e.preventDefault(), pullMenu(e));
paintPull();
addEventListener("focus", () => (autoFetch(), loadPrs()));
// every minute, a fetch once the Settings tab's interval has passed
setInterval(() => autoFetch(fetchMinutes() * 60_000), 60_000);
document.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => (b.onclick = () => setMode(b.dataset.mode as Mode)));
document.querySelectorAll<HTMLElement>("[data-svg]").forEach((b) => (b.onclick = () => setSvgView(b.dataset.svg!)));
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
// a click on the dimmed backdrop closes it: pressed there too, not a text selection dragged out of a field and let go there
let pressedOn: EventTarget | null = null;
$("dialog").onpointerdown = (e) => (pressedOn = e.target);
$("dialog").onclick = (e) => {
  if (e.target === $("dialog") && pressedOn === $("dialog")) closeDialog();
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
$("find-open").onclick = openFind;
document.querySelectorAll<HTMLInputElement>(".file-filter").forEach((f) => (f.oninput = () => filterFiles(f.value)));
$("stage-all").onclick = () => {
  const files = pickedFiles("unstaged");
  gitOp(files ? "stage" : conflictCount() ? "resolve-all" : "stage-all", files ? pathArg(files) : "");
};
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
$("discard-all").onclick = () => {
  const files = pickedFiles("unstaged"), staged = pickedFiles("staged");
  if (files || staged) return confirmDiscard((files ?? staged)!, !!staged);
  ask("Discard ALL changes: staged, unstaged and untracked files? This cannot be undone.", "Discard all").then((ok) => ok && gitOp("discard-all"));
};
$("unstage-all").onclick = () => {
  const files = pickedFiles("staged");
  gitOp(files ? "unstage" : "unstage-all", files ? pathArg(files) : "");
};
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
$("undo").oncontextmenu = (e) => undoMenu(e, true);
$("redo").oncontextmenu = (e) => undoMenu(e, false);
// one switch for both panels: the commit's files or the repository's
document.querySelectorAll<HTMLElement>(".all-files").forEach((b) => (b.onclick = () => (document.querySelectorAll(".all-files").forEach((x) => x.classList.toggle("on")), renderPanel())));
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
// the unstaged list's share of the two lists' height, 1 for half
resizer($("files-grip"), $("wip"), "unstaged-share", (m) => {
  const u = $("unstaged").getBoundingClientRect(), both = u.height + $("staged").clientHeight;
  return (2 * Math.min(both - 60, Math.max(60, m.clientY - u.top))) / both;
}, "--unstaged-share", "");
resizer($("commit-grip"), $("commit-msg"), "msg-height", (m) => Math.min(innerHeight * 0.6, Math.max(60, m.clientY - $("commit-msg").getBoundingClientRect().top)));
export const main = document.querySelector("main")!;
resizer($("graph-grip"), $("graph"), "graph-width", (m) => Math.max(64, m.clientX - $("graph-grip").parentElement!.getBoundingClientRect().left), "--graph-max");
// dragged or redrawn, the column keeps its lanes' scroll in range and its fades right
new ResizeObserver(() => scrollLanes()).observe($("graph-grip").parentElement!);
$("graph").onwheel = wheelLanes;
$("lane-bar").onscroll = laneBarScrolled;
resizer($("sidebar-grip"), main, "sidebar-width", (m) => Math.min(480, Math.max(160, m.clientX)), "--sidebar-w");
// the folded sidebar slides open over the diff while the pointer rests on it, or at once on a click; its rows stay until it is folded back
let peeking = 0;
const peek = (on: boolean) => (clearTimeout(peeking), $("sidebar").classList.toggle("open", on), on && $("sidebar").classList.add("peek"));
$("sidebar").onmouseenter = () => (peeking = setTimeout(() => peek(true), 250));
$("sidebar").onmouseleave = () => peek(false);
$("sidebar").ontransitionend = (e) => e.target === $("sidebar") && e.propertyName === "width" && !$("sidebar").classList.contains("open") && $("sidebar").classList.remove("peek");
$("sidebar").addEventListener("click", (e) => main.classList.contains("rail") && !$("sidebar").classList.contains("open") && (e.preventDefault(), e.stopPropagation(), peek(true)), true);
// the text zoomed by steps from the diff's bar, the history's too: off 100% the button says how much, and each step shows it a moment in the bubble under it
const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const zoomShown = () => !!$("zoom").offsetParent;
let fading = 0;
function zoom(to: number, pop = true) {
  const pct = `${Math.round(to * 100)}%`;
  store("zoom", String(to));
  setFontSize(13 * to);
  $("zoom").title = `Text zoom ${pct}`;
  $("zoom").querySelector("svg")!.outerHTML = svg(to < 1 ? ICONS.zoomOut : ICONS.zoomIn);
  $("zoom-n").textContent = to === 1 ? "" : pct;
  $("zoom-at").textContent = pct;
  if (pop) showZoom(false);
}
const zoomBy = (by: number, at = ZOOMS.indexOf(Number(store("zoom") ?? 1))) => zoom(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (at < 0 ? 5 : at) + by))]);
/** The bubble under the button: until a click elsewhere when `stay`, else gone a moment after the last step, once the pointer is off it. */
function showZoom(stay: boolean) {
  const p = $("zoom-pop"), at = $("zoom").getBoundingClientRect();
  if (!zoomShown()) return;
  clearTimeout(fading);
  if (stay) p.dataset.stay = "1";
  p.hidden = false;
  p.style.left = `${Math.min(at.right, innerWidth - 4) - p.offsetWidth}px`;
  p.style.top = `${at.bottom + 4}px`;
  const fade = () => (p.matches(":hover") ? (fading = setTimeout(fade, 400)) : hideZoom());
  if (!p.dataset.stay) fading = setTimeout(fade, 1500);
}
const hideZoom = () => (clearTimeout(fading), ($("zoom-pop").hidden = true), delete $("zoom-pop").dataset.stay);
zoom(Number(store("zoom") ?? 1) || 1, false);
// long lines wrapped in the diff and the history, Alt+Z as in code editors
const wrap = (on: boolean) => (store("word-wrap", on ? "on" : "off"), $("wrap").classList.toggle("on", on), setWordWrap(on));
wrap(store("word-wrap") === "on");
$("wrap").onclick = () => wrap(!$("wrap").classList.contains("on"));
$("zoom").onclick = () => ($("zoom-pop").dataset.stay ? hideZoom() : showZoom(true));
$("zoom-in").onclick = () => zoomBy(1);
$("zoom-out").onclick = () => zoomBy(-1);
$("zoom-reset").onclick = () => (zoom(1, false), hideZoom());
addEventListener("pointerdown", (e) => !(e.target as HTMLElement).closest("#zoom-pop, #zoom") && hideZoom(), true);
// Ctrl+wheel over the text too, a step a notch: a touchpad's pinch sends many small ones
let pinched = 0;
addEventListener("wheel", (e) => {
  if (!mod(e) || !zoomShown() || !(e.target as HTMLElement).closest?.("#diff-editor, #hist-file")) return;
  e.preventDefault();
  e.stopPropagation();
  if (Math.abs((pinched += e.deltaY)) < 50) return;
  zoomBy(pinched < 0 ? 1 : -1);
  pinched = 0;
}, { capture: true, passive: false });
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
$("next-change").onclick = nextChange;
$("pr-close").onclick = () => closePr();
$("pr-page").onclick = $("pr-page").onauxclick = followPrLink;
$("open-editor").onclick = openDiffFile;
$("diff-save").onclick = () => save().then(refresh);
$("open-repo").onclick = openPicked;
$("settings-btn").onclick = $("settings-home").onclick = openSettings;
$("m-sync").classList.toggle("on", store("merge-sync") !== "off");
$("m-sync").onclick = () => store("merge-sync", $("m-sync").classList.toggle("on") ? "on" : "off");
$("init-repo").onclick = async () => {
  const p = await pickDir("Select folder to init");
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
addEventListener("click", () => ($("menu").hidden = $("submenu").hidden = true));
// any press outside closes the tab search, even one a button keeps to itself: its list would be stale
addEventListener("pointerdown", (e) => !(e.target as HTMLElement).closest("#tab-search, #tab-find") && ($("tab-search").hidden = true), true);
// WebKit's Reload/Back menu means nothing here; inputs and Monaco keep theirs
addEventListener("contextmenu", (e) => !(e.target as HTMLElement).closest("input, textarea, #diff-editor") && e.preventDefault());
addEventListener("keydown", (e) => {
  // a dialog's answer acts on the tab it was asked in: no leaving it meanwhile
  const key = e.key.toLowerCase(), asking = !$("dialog").hidden;
  if (e.ctrlKey && e.code === "Backquote") (e.preventDefault(), toggleTerm());
  // GTK turns Shift+Tab into ISO_Left_Tab: the physical key is the sure one
  // by the key's place too: Ctrl+0 is Ctrl+à on AZERTY
  else if (mod(e) && zoomShown() && (key === "=" || key === "+" || e.code === "NumpadAdd")) (e.preventDefault(), zoomBy(1));
  else if (mod(e) && zoomShown() && (key === "-" || e.code === "NumpadSubtract")) (e.preventDefault(), zoomBy(-1));
  else if (mod(e) && zoomShown() && (e.code === "Digit0" || e.code === "Numpad0")) (e.preventDefault(), zoom(1));
  else if (e.ctrlKey && e.code === "Tab") (e.preventDefault(), asking || switchTab((active + (e.shiftKey ? tabs.length - 1 : 1)) % tabs.length));
  // the shell owns every other key
  else if ((e.target as HTMLElement).closest?.("#term")) return;
  // back from a worktree or a submodule to its repository, from anywhere but the shell
  else if (e.altKey && e.key === "ArrowLeft" && tabs[active].parent && !asking) (e.preventDefault(), stepBack());
  else if (e.altKey && !mod(e) && key === "z" && $("wrap").offsetParent) (e.preventDefault(), $("wrap").click());
  // the rebase plan's keys, unless a dialog, a menu, a diff over it or a field has them
  else if ($("dialog").hidden && $("menu").hidden && $("diff").hidden && !(e.target as HTMLElement).closest?.("select, input, textarea") && rebaseKey(e)) e.preventDefault();
  else if (e.key === "F5") (e.preventDefault(), refresh());
  else if (mod(e) && e.shiftKey && key === "t") (e.preventDefault(), asking || reopenTab());
  else if (mod(e) && key === "t") (e.preventDefault(), asking || addTab());
  else if (mod(e) && key === "o") (e.preventDefault(), asking || openPicked());
  else if (mod(e) && key === "n") (e.preventDefault(), asking || cloneDialog());
  else if (mod(e) && key === "i") (e.preventDefault(), asking || $("init-repo").click());
  else if (mod(e) && key === "w") (e.preventDefault(), asking || closeTab(active));
  // fields and buttons answer Enter themselves: elsewhere in a dialog it means its main action
  else if (e.key === "Enter" && !$("dialog").hidden && !(e.target as HTMLElement).closest?.("input, textarea, button, select"))
    (e.preventDefault(), $("dialog").querySelector<HTMLElement>("button.primary")?.click());
  // the open diff's changes, from anywhere but a field or a text being edited; a greyed arrow says why
  else if (!mod(e) && !e.altKey && (key === "p" || key === "n") && diffFile && !$("diff").hidden && $("dialog").hidden && !(e.target as HTMLElement).closest?.(`input:not([type=checkbox]), textarea, #merge, #hist-file${diffFile.kind === "unstaged" && diffFile.mod.exists && !diffFile.shown ? ", #diff-editor" : ""}`))
    (e.preventDefault(), $(key === "n" ? "next-change" : "prev-change").click());
  else if (e.key === "Escape") {
    if (!$("zoom-pop").hidden) hideZoom();
    else if (!$("menu").hidden) $("menu").hidden = $("submenu").hidden = true;
    else if (!$("banner").hidden) hideBanner();
    else if (!$("dialog").hidden) closeDialog();
    else if (!$("tab-search").hidden) $("tab-search").hidden = true;
    else if (!$("find").hidden && !openFile()) closeFind();
    else if (hist) closeHistory();
    else if (!$("diff").hidden) closeDiff();
    else if (merging) closeMerge();
    else if (!$("pr").hidden) closePr();
    else if (dismissToast()) e.preventDefault();
    // nothing left open: the graph itself steps back out of a worktree or a submodule
    else if (tabs[active].parent && !(e.target as HTMLElement).closest?.("input, textarea")) stepBack();
  } else if ((e.target as HTMLElement).closest?.("input:not([type=checkbox]), textarea, #diff-editor, #merge, #hist-file") || !repo) return;
  else if (mod(e) && key === "f") (e.preventDefault(), openFind());
  else if (mod(e) && key === "z") (e.preventDefault(), undoRedo(!e.shiftKey));
  else if (mod(e) && key === "y") (e.preventDefault(), undoRedo(false));
  else if (e.key.startsWith("Arrow") && !mod(e) && !e.altKey && !e.shiftKey) (e.preventDefault(), arrow(e.key));
  // a focused button or box keeps its Space
  else if (e.key === " " && !mod(e) && $("dialog").hidden && !(e.target as HTMLElement).closest?.("button, select, input, label") && fitImages()) e.preventDefault();
});

// Monaco and its diff worker warmed up under the splash: a cold first diff took ~0.5 s, and a file opened during the warm-up drew wrong
restoreTabs(loadMonaco().then(() => (diffEditor ? undefined : warmDiff())).catch(() => {}));
// once a run, as soon as it starts: git missing is said before any repository fails on it
checkTools().then((t) => t.git || warnOnce("no-git", "Git is not installed", t.gitHelp, "err"), () => {});
