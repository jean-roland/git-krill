// Monaco views: the diff with hunk and line staging, the merge tool, file history and blame.
import type * as Monaco from "monaco-editor/esm/vs/editor/edcore.main";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { applyChanges, allLines, pickLines, parseConflicts, mergeSides, pickedLines, parseBlame, toggleSide, toggleLine, hasSide, pickedOf } from "./core.js";
import { Blob, Change, Commit, active, busy, fakeCommit, gitOp, headHash, lfsChip, openInEditor, opInfo, recordUndo, refresh, repo, run, selection, status, tabs } from "./repo";
import { $, COLORS, ICONS, MenuItem, ask, avatar, avatarSvg, basename, colorIndex, copy, cssVar, dateText, dateTimeText, esc, h, hideBanner, input, megabytes, plural, popup, say, short, showBanner, store, svg, toast, whileLoading } from "./ui";
import { fileLists, isConflict, isSubmodule, markOpenFile, paintRail, wipFiles } from "./panel";
import { openSubmodule } from "./graph";

export type DiffSource = "unstaged" | "staged" | "commit";
export type Mode = "hunk" | "inline" | "split";
type LineChange = { os: number; oe: number; ms: number; me: number };
type Lines = { removed: Set<number>; added: Set<number> };

(self as any).MonacoEnvironment = { getWorker: () => new EditorWorker() };
// most of the bundle: loaded after the first paint, awaited by whatever opens a diff
export let monaco: typeof Monaco;
let monacoLoad: Promise<void> | null = null;
export const loadMonaco = () =>
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
      "editor.background": cssVar("--bg"),
      "editorGutter.background": cssVar("--bg"),
      // else it follows the minimap's on/off, which the diff editor flips on every update: the flip wiped the marks
      "editorOverviewRuler.background": cssVar("--bg"),
      "editorLineNumber.foreground": "#5d6575",
      "editorLineNumber.activeForeground": cssVar("--text"),
      "editor.lineHighlightBackground": "#222833",
      "editor.selectionBackground": `${cssVar("--accent")}66`,
      "editorWidget.background": cssVar("--panel"),
      "scrollbarSlider.background": "#ffffff14",
      "diffEditor.insertedLineBackground": `${cssVar("--add")}14`,
      "diffEditor.insertedTextBackground": `${cssVar("--add")}28`,
      "diffEditor.removedLineBackground": `${cssVar("--del")}14`,
      "diffEditor.removedTextBackground": `${cssVar("--del")}28`,
      "diffEditor.diagonalFill": "#ffffff0c",
      "diffEditorGutter.insertedLineBackground": `${cssVar("--add")}30`,
      "diffEditorGutter.removedLineBackground": `${cssVar("--del")}30`,
      "diffEditorOverview.insertedForeground": `${cssVar("--add")}99`,
      "diffEditorOverview.removedForeground": `${cssVar("--del")}99`,
      // the bracket pair guides in their brackets' colours (the dark theme's), half strength: Monaco's 30 % is too faint
      "editorBracketPairGuide.background1": "#FFD70080",
      "editorBracketPairGuide.background2": "#DA70D680",
      "editorBracketPairGuide.background3": "#179FFF80",
    },
  });
  }));
type SubCommit = { hash: string; subject: string };
type SubmoduleChange = { old: SubCommit | null; new: SubCommit | null; added: SubCommit[]; removed: SubCommit[]; changed: number; untracked: number; initialized: boolean };
// full: loaded past the size a diff loads unasked; sub: what a submodule went through, shown instead of a text diff; ids: its sides' versions, see versionIds
// same: no change when opened (an All files entry), so no Diff view; file: shown as the file alone (File view); drawn: shown as images or a page; pane: shown as images or a card, no text;
// shown: the text in the editor in place of the blobs', a binary's listing or a big file's parts so far; more: how to load its next part
export let diffFile: { kind: DiffSource; f: Change; c?: Commit; orig: Blob; mod: Blob; dirty: boolean; full: boolean; same: boolean; file?: boolean; drawn?: boolean; pane?: boolean; sub?: SubmoduleChange; ids?: string; listing?: Listing; shown?: [string, string]; more?: More; seq?: number; loading?: boolean } | null = null;
// a binary's sides as text: an object file's sections and symbols when asked and one, else hex dumps
type Listing = { symbols: boolean; object: boolean };
// what is shown of a file loaded a part at a time, the loader of both sides' next part (or up to a new side's line), and the new side's line where git's next change past them ends
// load: the part, and what is more after it; back: a side's last bytes to read again with the next part, false when that cannot line them up
type More = { label: string; load?: (until?: number) => Promise<[[string, string], More | undefined]>; change?: number; back?: (side: number, bytes: number) => boolean };
export let diffEditor: Monaco.editor.IStandaloneDiffEditor | null = null;
// hunk header bars, as view zone ids per side
let hunkZones: { mod: string[]; orig: string[]; nodes: HTMLElement[] } = { mod: [], orig: [], nodes: [] };
let hunks: LineChange[] = [];
// the hunks' marks in the modified side's scrollbar
let lastSide: "orig" | "mod" = "mod";
let modelSeq = 0;
// the diff editor's view model: ours to dispose
let diffView: Monaco.editor.IDiffEditorViewModel | null = null;
// a fresh URI each time: the language comes from the path's extension, and an old model may still hold the last one
const newModel = (text: string, path: string) => monaco.editor.createModel(text, undefined, monaco.Uri.from({ scheme: "krill", path: `/${++modelSeq}/${path}` }));

/* diff */

export function editor() {
  if (diffEditor) return diffEditor;
  diffEditor = monaco.editor.createDiffEditor($("diff-editor"), {
    ...plainOpts(),
    wordWrap,
    // whitespace-only changes must show: they get staged too
    ignoreTrimWhitespace: false,
    originalEditable: false,
    renderMarginRevertIcon: false,
    renderGutterMenu: false,
    useInlineViewWhenSpaceIsLimited: false,
    // the size cap is ours: past it a file loads only when asked
    maxFileSize: 0,
  });
  const me = diffEditor.getModifiedEditor();
  lineActions(me, false);
  lineActions(diffEditor.getOriginalEditor(), true);
  revealMoreBar(me);
  me.onDidFocusEditorText(() => (lastSide = "mod"));
  diffEditor.getOriginalEditor().onDidFocusEditorText(() => (lastSide = "orig"));
  diffEditor.onDidUpdateDiff(updateHunkBars);
  me.onDidLayoutChange(fitHunkBars);
  // the text layer covers view zones and Monaco hit-tests itself: match the mouse to a bar button by position
  const barButton = (e: Monaco.editor.IEditorMouseEvent) => {
    if (e.target.type !== monaco.editor.MouseTargetType.CONTENT_VIEW_ZONE) return undefined;
    const node = hunkZones.nodes[hunkZones.mod.indexOf(e.target.detail.viewZoneId)];
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
  // Monaco's commands are global, the last one added wins: each picks by what is open
  me.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => (merging ? saveMerge() : save().then(refresh)));
  applyMode();
  return diffEditor;
}

/** The line-level actions of one side: a +/− on the hovered changed line and the right-click menu. */
function lineActions(ed: Monaco.editor.ICodeEditor, orig: boolean) {
  const hover = ed.createDecorationsCollection();
  const staging = () => !!diffFile && diffFile.kind !== "commit" && !diffFile.shown;
  const changed = (l: number) => hunks.some((c) => (orig ? c.oe && l >= c.os && l <= c.oe : c.me && l >= c.ms && l <= c.me));
  const act = () => (diffFile?.kind === "staged" ? "unstage" : "stage");
  let at = -1;
  ed.onMouseMove((e) => {
    // a view zone reports the line next to it
    const zone = [monaco.editor.MouseTargetType.CONTENT_VIEW_ZONE, monaco.editor.MouseTargetType.GUTTER_VIEW_ZONE].includes(e.target.type);
    const l = zone ? 0 : (e.target.position?.lineNumber ?? 0);
    if (l === at) return;
    at = l;
    const on = staging() && changed(l);
    const cls = `line-act ${act()}`;
    hover.set(on ? [{ range: new monaco.Range(l, 1, l, 1), options: { glyphMarginClassName: cls, glyphMarginHoverMessage: { value: `${act() === "stage" ? "Stage" : "Unstage"} this line` } } }] : []);
  });
  ed.onMouseLeave(() => ((at = -1), hover.clear()));
  ed.onMouseDown((e) => {
    at = -1;
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
    const lines = (action: "stage" | "unstage" | "discard") => () => applyLines(selectedLines(), action);
    popup(e.event.browserEvent, [
      ...(diffFile?.kind === "unstaged" && staging()
        ? ([["Discard selected lines", lines("discard")], ["Stage selected lines", lines("stage")]] as MenuItem[])
        : []),
      ...(diffFile?.kind === "staged" && staging() ? ([["Unstage selected lines", lines("unstage")]] as MenuItem[]) : []),
      ...(diffFile?.kind === "commit" && diffFile.c?.hash !== "WORKTREE" && !diffFile.shown && !selection.pr ? ([["Revert selected lines", () => revertLines(selectedLines(), "lines")]] as MenuItem[]) : []),
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
  // Monaco never wraps the old side in one column, and forgets to undo it back in Split
  if (o.renderSideBySide) editor().getOriginalEditor().updateOptions({ wordWrapOverride2: "inherit" });
  // the diff editor forces its sub-editors' minimap off on every update; only Inline has room and use for one
  const minimap = { enabled: viewMode() === "inline", renderCharacters: false, showSlider: "always" as const };
  editor().getModifiedEditor().updateOptions({ minimap });
}

export function setMode(m: Mode) {
  store("diff-mode", m);
  applyMode();
}

/** The Diff view's layout: images side by side; Monaco cannot fold a file loaded on request, so Inline stands in for Hunk there. */
const viewMode = (): Mode => {
  const m = (store("diff-mode") as Mode) || "hunk";
  return diffFile?.drawn ? "split" : m === "hunk" && fullText() ? "inline" : m;
};

// nothing to compare: no change, a deleted file, a new one but for its lines to pick, which a drawn file, a listing or parts lack
const noDiff = () => !!diffFile && (diffFile.same || !diffFile.mod.exists || (!diffFile.orig.exists && (!!diffFile.drawn || !!diffFile.shown)));
// the File view: a file with nothing to compare has no other; the history has its own
const fileView = () => !!diffFile && !hist && (noDiff() || !!diffFile.file);
// the File view of a file still there: one text on both sides, Monaco has nothing to compute
const collapsed = () => fileView() && !!diffFile?.mod.exists;

// a text loaded on request, whole or in parts: a binary's listing stays small
const fullText = () => !!diffFile && !diffFile.listing && (diffFile.full || !!diffFile.shown);

function applyMode() {
  const m = viewMode(), full = fullText(), file = fileView(), d = diffFile;
  // Hunk shows little but changes: no overview of them, its width back to the text; elsewhere the overview's box is the scrollbar
  const overview = m !== "hunk";
  setOptions({ renderSideBySide: m === "split", hideUnchangedRegions: { enabled: m === "hunk" }, renderOverviewRuler: overview, scrollbar: { vertical: overview ? "hidden" : "auto", verticalScrollbarSize: overview ? 0 : 28 } });
  updateHunkBars();
  document.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  const [prev, next, hunk, inline, split] = diffButtons();
  // on top of paintSides' dimming, which clears it for a text diff: no diff to lay out in the File view; images, only side by side and no change to step to; Monaco cannot fold a file that big
  (file ? [prev, next, hunk, inline, split] : d?.drawn ? [prev, next, hunk, inline] : full ? [hunk] : []).forEach((b) => b.classList.add("off"));
  hunk.dataset.title = full ? "Can't show hunks for files over 10 MB" : "Changed hunks only";
  tipDiffOnly(file);
  document.querySelectorAll<HTMLElement>("[data-dview]").forEach((b) => b.classList.toggle("on", (b.dataset.dview === "file") === file));
  const diff = document.querySelector<HTMLElement>('[data-dview="diff"]')!;
  if (noDiff()) diff.classList.add("off");
  diff.title = !d || !noDiff() ? "Its changes, by hunk, inline or side by side" : d.same ? "No changes to compare" : d.mod.exists ? "A new file: nothing to compare" : "A deleted file: nothing to compare";
}

// the Diff view's own buttons: the change arrows and the layouts
const diffButtons = () => [$("prev-change"), $("next-change"), ...document.querySelectorAll<HTMLElement>("[data-mode]")];
/** The Diff view's buttons' tips, saying so where a File view greys them (their own in data-title: data-tip pops a tooltip). */
const tipDiffOnly = (on: boolean) => diffButtons().forEach((b) => (b.title = (b.dataset.title ??= b.title) + (on ? " (Diff mode only)" : "")));

/** The diff's old side as its view needs it: the new side itself in the File view, its own text, to compare, in the Diff view; whether it changed. */
function fitOriginal() {
  const d = diffFile, v = diffView;
  if (!d || !v || (v.model.original === v.model.modified) === collapsed()) return false;
  const ed = editor(), at = ed.saveViewState(), modified = v.model.modified;
  diffView = ed.createViewModel({ original: collapsed() ? modified : newModel(d.shown?.[0] ?? d.orig.text, `a/${d.f.path}`), modified });
  ed.setModel(diffView);
  v.dispose();
  if (v.model.original !== modified) v.model.original.dispose();
  if (at) ed.restoreViewState(at);
  return true;
}

/** The open diff as its file alone, or as its changes, remembered for the next ones. */
export function setFileView(on: boolean) {
  if (!diffFile || (!on && noDiff())) return;
  store("diff-view", on ? "file" : "diff");
  diffFile.file = on;
  layOutView();
}

/** The File or the Diff view in place of the other, the line read still in sight, edits kept: one text under both. */
function layOutView() {
  // a card (a submodule, a file not downloaded or too big) has no views
  if (!$("diff-binary").hidden && !diffFile?.drawn) return;
  const spot = readingAt();
  if ($("diff-binary").hidden) {
    // a diff to compute now, maybe for seconds (a binary's hex dumps): the pointer says so until it lands
    if (fitOriginal() && !fileView()) diffDrawn(fullText() ? 300_000 : 500);
    $("diff-editor").hidden = fileView();
    $("diff-file").hidden = !fileView();
    paintFile();
  } else {
    // the new version stays as drawn, a moved frame would load again: the old one comes beside it, scrolled where it is, or goes
    const box = $("diff-binary").querySelector<HTMLElement>(".img-sides")!, old = box.querySelector(".img-side.del");
    // a deleted file's old version is all it shows; a repeated click, or a history step back to this commit, finds it there
    if (fileView()) {
      if (diffFile!.mod.exists) old?.remove();
    } else if (!old && diffFile!.orig.exists) {
      const [at, path] = sideSources(diffFile!.kind, diffFile!.f, diffFile!.c)[0];
      readAt = spot;
      const side = sideOf(diffFile!.f.path)(at, path, "del");
      readAt = null;
      box.prepend(side);
      const frames = [...box.querySelectorAll("iframe")], added = side.querySelector("iframe");
      // a page lands after the one read: lined up with it, then both scroll together; synced before, its own landing would lead and move the read one
      const lineUp = () => {
        const [read, landed] = [frames[1].contentDocument, added?.contentDocument];
        if (read && landed) followPage(read, landed);
        syncPages(frames);
      };
      if (added && PAGE.test(diffFile!.f.path)) added.addEventListener("load", lineUp, { once: true });
      else syncPages(frames);
    }
  }
  dimDiffOpts(false);
  applyMode();
  const ed = textEditor();
  if (spot && ed) showLine(spot, ed);
}

const lineChanges = (): LineChange[] =>
  (editor().getLineChanges() ?? []).map((c) => ({
    os: c.originalStartLineNumber,
    oe: c.originalEndLineNumber,
    ms: c.modifiedStartLineNumber,
    me: c.modifiedEndLineNumber,
  }));

/** Undo lines `pick` of the shown commit in the working tree, where they show up unstaged for review. */
async function revertLines(pick: Lines, what: string) {
  if (!diffFile?.c) return;
  if (!pick.removed.size && !pick.added.size) return noLines();
  const { f, orig, mod } = diffFile, at = diffFile.c, ch = lineChanges(), all = allLines(ch);
  const text = applyChanges(orig.text, mod.text, ch, minus(all.removed, pick.removed), minus(all.added, pick.added));
  try {
    // a file the commit added goes once all of it is taken back
    await run("revert_lines", { commit: at.hash, path: f.path, text: text || orig.exists ? text : null });
    toast(`Reverted ${what} of ${basename(f.path)}`, `From ${short(at.hash)}: the change is in the working tree, unstaged.`, "info");
  } catch (e) {
    say(String(e), true);
  }
  refresh();
}

/** The bar ending a file shown in parts: how much is shown, a button for the next part. */
const moreBar = (d: NonNullable<typeof diffFile>) =>
  d.more && h("div", {}, h("div", { className: "hunk-bar more-bar" }, h("span", { textContent: d.more.label }), ...(d.more.load ? [h("button", { textContent: "Load more", onclick: () => loadMore(d) })] : [])));
// Monaco reveals the last line only: the bar under it would show by half
const revealMoreBar = (ed: Monaco.editor.ICodeEditor) =>
  ed.onDidChangeCursorPosition((e) => e.reason === monaco.editor.CursorChangeReason.Explicit && diffFile?.more && e.position.lineNumber === ed.getModel()?.getLineCount() && ed.setScrollTop(ed.getScrollHeight()));

/** A header bar above each hunk with its stage / unstage / discard / revert buttons. */
function updateHunkBars() {
  const ed = editor(), split = viewMode() === "split";
  const acts: [string, string][] =
    !diffFile || diffFile.shown ? []
    : diffFile.kind === "unstaged" ? [["discard", "Discard hunk"], ["stage", "Stage hunk"]]
    : diffFile.kind === "staged" ? [["unstage", "Unstage hunk"]]
    // a pull request's changes are not this checkout's to take back
    : diffFile.c?.hash !== "WORKTREE" && !selection.pr ? [["revert", "Revert hunk"]]
    : [];
  hunks = diffFile ? lineChanges() : [];
  // bars head the hunks between folds; in the whole file the line numbers say where a change is
  const shown = viewMode() === "hunk" ? hunks : [];
  const bar = (c: LineChange, buttons: boolean) => {
    const count = (s: number, e: number) => (e ? e - s + 1 : 0);
    const el = h("div", { className: "hunk-bar" }, h("span", { textContent: `@@ -${c.os},${count(c.os, c.oe)} +${c.ms},${count(c.ms, c.me)} @@` }));
    if (buttons)
      for (const [act, label] of acts) {
        el.append(h("button", { className: `hunk-${act}`, textContent: label, onclick: () => (act === "revert" ? revertLines(allLines([c]), "a hunk") : applyLines(allLines([c]), act as "stage" | "unstage" | "discard")) }));
      }
    // Monaco sets display on the zone node itself: the flex bar goes inside it
    return h("div", {}, el);
  };
  // a pure insertion or deletion sits after its anchor line, a change replaces lines from its start
  // a file shown in parts ends on a bar to load the next one
  const d = diffFile, more = d && moreBar(d);
  const last = (e: Monaco.editor.ICodeEditor) => e.getModel()?.getLineCount() ?? 0;
  // Hunk folds the rows after the last change but its 3 lines of context: the bar goes there, at the top with no change
  const end = viewMode() !== "hunk" ? last(ed.getModifiedEditor()) : hunks.length ? Math.min(last(ed.getModifiedEditor()), Math.max(...hunks.map((c) => c.me || c.ms)) + 3) : 0;
  ed.getModifiedEditor().changeViewZones((z) => {
    hunkZones.mod.forEach((id) => z.removeZone(id));
    hunkZones.nodes = shown.map((c) => bar(c, true));
    hunkZones.mod = shown.map((c, i) => z.addZone({ afterLineNumber: c.me ? c.ms - 1 : c.ms, heightInPx: 30, domNode: hunkZones.nodes[i] }));
    // tied to its line's start: Monaco hides a zone when the line after it is folded
    if (more) hunkZones.nodes.push(more), hunkZones.mod.push(z.addZone({ afterLineNumber: end, afterColumn: 1, heightInPx: 40, domNode: more }));
  });
  // the File view ends on its own
  fileEd?.changeViewZones((z) => {
    z.removeZone(fileMore);
    const node = fileView() && d && moreBar(d);
    fileMore = node ? z.addZone({ afterLineNumber: last(fileEd!), afterColumn: 1, heightInPx: 40, domNode: node }) : "";
  });
  // the original side gets the same bars in split view, so both sides stay aligned
  ed.getOriginalEditor().changeViewZones((z) => {
    hunkZones.orig.forEach((id) => z.removeZone(id));
    hunkZones.orig = split ? shown.map((c) => z.addZone({ afterLineNumber: c.oe ? c.os - 1 : c.os, heightInPx: 30, domNode: bar(c, false) })) : [];
    // its label across from it
    if (split && more) hunkZones.orig.push(z.addZone({ afterLineNumber: last(ed.getOriginalEditor()), afterColumn: 1, heightInPx: 40, domNode: h("div", {}, h("div", { className: "hunk-bar more-bar" }, h("span", { textContent: d!.more!.label }))) }));
  });
  fitHunkBars();
}

/** Hunk bars as wide as the visible text area, not the longest line, so the buttons stay in view. */
function fitHunkBars() {
  const fit = (box: HTMLElement, lay: Monaco.editor.EditorLayoutInfo) => box.querySelectorAll<HTMLElement>(".hunk-bar").forEach((b) => (b.style.width = `${lay.contentWidth - lay.verticalScrollbarWidth}px`));
  fit(editor().getContainerDomNode(), editor().getModifiedEditor().getLayoutInfo());
  if (fileEd) fit(fileEd.getContainerDomNode(), fileEd.getLayoutInfo());
}

/** Where a diff's old and new sides are read: [at, path], at empty for a root commit's old side. */
function sideSources(kind: DiffSource, f: Change, c?: Commit): [string, string][] {
  const old = f.old ?? f.path;
  if (kind === "unstaged") return [["INDEX", f.path], ["WORKTREE", f.path]];
  if (kind === "staged") return [["HEAD", old], ["INDEX", f.path]];
  return [[c!.parents[0] ?? "", old], [c!.hash, f.path]];
}

/** What tells the sides' versions apart, asked before reading them again: a refresh mostly finds nothing changed. */
const versionIds = (kind: DiffSource, f: Change, c?: Commit) => run<string[]>("version_ids", { sides: sideSources(kind, f, c) }).then((ids) => ids.join("\n"), () => "");

async function fetchSides(kind: DiffSource, f: Change, c?: Commit, full = false): Promise<[Blob, Blob]> {
  const none: Blob = { text: "", exists: false, binary: false, large: null, lfs: "" };
  // a full load has its own spinner, and may never answer: kept off the busy pointer
  const [o, m] = sideSources(kind, f, c).map(([at, path]) => (at ? run<Blob>("blob", { at, path, full }, full) : Promise.resolve(none)));
  return Promise.all([o, m]);
}

/** Whether the open diff's and merge's unsaved edits may go, asking first; nothing closes yet. */
export const confirmDrop = async () =>
  (!diffFile?.dirty || (await ask(`Drop unsaved edits to ${diffFile.f.path}?`, "Drop edits"))) && (!merging?.dirty || (await ask(`Drop the merge of ${merging.f.path}?`, "Drop")));

/** What submodule `f` went through between the diff's two sides. */
function submoduleChange(kind: DiffSource, f: Change, c?: Commit) {
  const [from, to] = kind === "unstaged" ? ["INDEX", "WORKTREE"] : kind === "staged" ? ["HEAD", "INDEX"] : [c!.parents[0] ?? "", c!.hash];
  return run<SubmoduleChange>("submodule_change", { path: f.path, from, to });
}

// the latest file asked for: an earlier one still loading gives way
let openSeq = 0;
/** A diff still loading gives way: another tab takes the window. */
export const cancelOpen = () => void openSeq++;

/** Whether two versions are known to be one: a binary's or a big file's text is empty, it tells nothing. */
const alike = (a: Blob, b: Blob) => a.text === b.text && a.exists === b.exists && a.binary === b.binary && a.large === b.large && a.lfs === b.lfs && !a.binary && !a.large;

export async function openDiff(kind: DiffSource, f: Change, c?: Commit, inHistory = false) {
  const seq = ++openSeq;
  await loadMonaco();
  // a file picked outside the history leaves it
  if (hist && !inHistory) await closeHistory();
  if (kind === "unstaged" && isConflict(f)) return openConflict(f);
  // clicking the open file again closes it
  if (diffFile && diffFile.kind === kind && diffFile.f.path === f.path && diffFile.c?.hash === c?.hash && diffFile.c?.parents[0] === c?.parents[0]) return closeDiff();
  if (!(await confirmDrop())) return;
  let orig: Blob, mod: Blob, sub: SubmoduleChange | undefined, ids: string | undefined;
  try {
    if (f.sub ?? isSubmodule(f.path)) {
      sub = await submoduleChange(kind, f, c);
      orig = mod = { text: "", exists: false, binary: false, large: null, lfs: "" };
    } else [[orig, mod], ids] = await Promise.all([fetchSides(kind, f, c), versionIds(kind, f, c)]);
  } catch (e) {
    return say(String(e), true);
  }
  if (seq !== openSeq) return;
  // what is on screen stays until the new diff is drawn: the graph under a see-through pane, a merge or diff under a still copy, drawn images held in place (paintSides)
  const gen = ++opening, fresh = $("diff").hidden && !merging;
  const copy = document.querySelector(".still") ?? still(merging ? $("merge") : [$("diff-editor"), $("diff-binary")].find((e) => !$("diff").hidden && !e.hidden && !e.classList.contains("images")));
  await closeMerge(true);
  dropParked();
  diffFile = { kind, f, c, orig, mod, dirty: false, full: false, same: !sub && (!f.code || alike(orig, mod)), sub, ids };
  if (fresh) $("diff").classList.add("blank");
  $("diff").hidden = false;
  const range = c ? `  ·  ${c.parents[0] ? short(c.parents[0]) : "root"}..${short(c.hash)}` : "";
  $("diff-path").replaceChildren(...(orig.lfs || mod.lfs ? [lfsChip()] : []), (f.old ? `${f.old} → ${f.path}` : f.path) + range);
  // set again once the text is in the editor: an image, a binary file or a submodule has none
  $("diff-editable").hidden = $("diff-save").hidden = true;
  paintOpenEditor();
  markOpenFile();
  // Monaco normalizes line endings, so a CRLF<->LF rewrite would not show at all
  const eol = (t: string) => (t.includes("\r\n") ? "CRLF" : t.includes("\n") ? "LF" : "");
  // a work file's CRLFs may be git's own checkout of LF text (autocrlf): not a change then
  if (eol(orig.text) && eol(mod.text) && eol(orig.text) !== eol(mod.text))
    // not for LFS: its clean filter would store the probe as an object
    ((kind === "unstaged" || c?.hash === "WORKTREE") && eol(mod.text) === "CRLF" && !f.lfs ? run<boolean>("keeps_crlf", { path: f.path }) : Promise.resolve(true)).then(
      (kept) => kept && say(`${f.path}: line endings changed ${eol(orig.text)} → ${eol(mod.text)}, not shown in the diff`, true),
      () => {},
    );
  // a later file keeps the cover up until its own diff is drawn
  // the sidebar folds in the frame the diff shows, its editors laid out to the new width first
  paintSides().then(() => requestAnimationFrame(() => gen === opening && (copy?.remove(), $("diff").classList.remove("blank"), paintRail(), drawNow())));
}

let opening = 0;

/** A still copy of `el` laid over it, for the new view to draw unseen underneath. */
function still(el?: HTMLElement) {
  if (!el) return null;
  const copy = el.cloneNode(true) as HTMLElement;
  // canvases (minimap, overview ruler) do not clone their pixels
  const from = el.querySelectorAll("canvas");
  copy.querySelectorAll("canvas").forEach((c, i) => from[i].width && from[i].height && c.getContext("2d")?.drawImage(from[i], 0, 0));
  // a copied frame would load again, blank then at its top: left empty, the pane shows through instead
  copy.querySelectorAll("iframe").forEach((f) => (f.removeAttribute("srcdoc"), f.removeAttribute("src"), (f.style.visibility = "hidden")));
  copy.classList.add("still");
  Object.assign(copy.style, { position: "absolute", zIndex: "20", pointerEvents: "none", left: `${el.offsetLeft}px`, top: `${el.offsetTop}px`, width: `${el.offsetWidth}px`, height: `${el.offsetHeight}px` });
  // after it: its ids still find the live element
  el.after(copy);
  return copy;
}

// lib.rs MAX_ASKED: past it a file does not load even when asked
const MAX_ASKED = 200 << 20;

// a drawn view held over the editor while its text comes back: in place, as a moved frame reloads and a shown image's URL is gone
let cover: HTMLElement | null = null;

/** The open diff's sides in the editor, or in their place a submodule's card, the images, or why not: not downloaded, an image too big. */
function paintSides(): Promise<unknown> {
  const d = diffFile!, { kind, f, c, orig, mod, sub } = d;
  // a load still under way is for the view before
  d.seq = (d.seq ?? 0) + 1;
  const binary = orig.binary || mod.binary, large = Math.max(orig.large ?? 0, mod.large ?? 0);
  const missing = orig.lfs === "missing" || mod.lfs === "missing", drawable = DRAWN.test(f.path) && !sub && !missing && !large;
  // a PDF without a binary byte is still one
  const images = ((binary || PDF.test(f.path)) && !missing && (!large || large <= IMAGE_UNASKED) && IMAGE.test(f.path)) || (drawable && store("svg-view") === "image");
  // any other binary compares as text, read first; a text too big to show at once comes in parts
  const listed = binary && !missing && !sub && !images && !IMAGE.test(f.path), symbols = store("bin-view") !== "text", parted = !binary && !!large && !sub;
  // back to a view kept aside: what it had loaded too
  const back = parked.get(viewKey());
  if (back) Object.assign(d, back.state);
  // the last file's text stays on screen while this one loads: read-only, a key typed there must not count for this one
  if ((listed && d.listing?.symbols !== symbols) || (parted && !d.shown)) setOptions({ readOnly: true });
  if (listed && d.listing?.symbols !== symbols) return loadListing(d, symbols).then((now) => now && diffFile === d && paintSides());
  if (parted && !d.shown) return loadParts(d).then((now) => now && diffFile === d && paintSides(), (e) => say(String(e), true));
  // the version a file opens in its app: the new one, the old when the file is gone
  const shown = sideSources(kind, f, c)[mod.exists ? 1 : 0];
  const pane = !!sub || images || (binary && !listed);
  // the view picked last, but the File view where a diff tells little or takes seconds: a binary's but an object file's symbols, a file loaded in parts
  d.file ??= d.same || !orig.exists || (images && !drawable) || (binary && !(d.listing?.object && d.listing.symbols)) || !!large || store("diff-view") === "file";
  // before the panes are picked: a drawn file has nothing to compare, the text it goes back to may
  d.drawn = images;
  d.pane = pane;
  cover?.removeAttribute("style");
  const b = $("diff-binary"), held = !pane && !b.hidden && b.classList.contains("images");
  cover = held ? b : null;
  // opaque: its padding would show the editor drawing underneath; under the view switch (15), which stays
  if (held) Object.assign(b.style, { position: "absolute", zIndex: "14", background: "var(--bg)", left: `${b.offsetLeft}px`, top: `${b.offsetTop}px`, width: `${b.offsetWidth}px`, height: `${b.offsetHeight}px` });
  $("diff-editor").hidden = pane || fileView();
  $("diff-file").hidden = pane || !fileView();
  if (!held) {
    b.hidden = !pane;
    b.classList.toggle("images", images);
  }
  paintSvgView(drawable || !!d.listing?.object, images || (!!d.listing?.object && symbols), f.path, listed);
  if (!held) b.replaceChildren(
    ...(sub
      ? submoduleCard(f.path, sub)
      : missing
        ? [`${basename(f.path)} is stored with Git LFS and this version is not downloaded: whole-file actions only.`, lfsFetchButton()]
        : images
          ? [imageSides()]
          : [`${basename(f.path)} is ${megabytes(large)}: too big to show unasked.`, forceLoadButton(large), openButton(...shown)]),
  );
  // a drawn SVG or page keeps its text's Save, greyed: the bar does not shift between views
  $("diff-editable").hidden = $("diff-save").hidden = !(drawable && kind === "unstaged" && mod.exists);
  ($("diff-save") as HTMLButtonElement).disabled = true;
  // no text diff: its view and change buttons have nothing to act on, but images still lay out by view
  dimDiffOpts(pane && !images);
  // no text to zoom: images, a page, a card
  $("zoom").classList.toggle("off", pane);
  applyMode();
  if (pane) return Promise.resolve(dropModels());
  // Monaco gives up on a diff after 5 s and marks the whole file changed: a file loaded on request gets the time it takes
  setOptions({ maxComputationTime: fullText() ? 0 : 5000 });
  const kept = setModels(false);
  // the folds land a moment after the text; a kept view's are there
  const mine = cover;
  const drawn = kept ? Object.assign(new Promise((r) => requestAnimationFrame(r)), { landed: Promise.resolve() }) : diffDrawn(fullText() ? 300_000 : 500);
  drawn.landed.then(() => alignTail(d));
  return drawn.then(() => {
    if (!mine || cover !== mine) return;
    cover = null;
    mine.removeAttribute("style");
    mine.hidden = true;
    mine.classList.remove("images");
    mine.replaceChildren();
  });
}

// lib.rs HEX_PART: a hex dump comes this much at a time
const HEX_PART = 64 << 10;
// past this a hex dump loads no more: rewritten whole, as a rebuilt binary is, each part froze the window longer, 2.7 s at 256 KB (1 MB: over a minute)
const HEX_MAX = 256 << 10;
// a text too big to show at once comes in parts of about this size; a jump to a change further down, in steps of this
const PART = 10 << 20;
const JUMP = 50 << 20;

/** Binary diff `d`'s sides as text: an object file's sections and symbols if `symbols`, else hex dumps a part at a time. */
async function loadListing(d: NonNullable<typeof diffFile>, symbols: boolean) {
  type Text = [boolean, string, boolean];
  const seq = d.seq;
  const sides = sideSources(d.kind, d.f, d.c), size = Math.max(d.orig.large ?? 0, d.mod.large ?? 0);
  // per side: the next byte to read, and whether more follow
  const next = [0, 0], left = [false, false];
  // whether an object file, the text, whether more bytes follow; past the first part only a side with more, not a symbol listing
  const read = () =>
    Promise.all(
      sides.map(([at, path], i) =>
        at && (i ? d.mod : d.orig).exists && (!next[i] || left[i])
          ? run<Text>("binary_text", { at, path, symbols, offset: next[i] })
              .catch((e): Text => [false, String(e), false])
              .then((t) => ((left[i] = t[2]), (next[i] += HEX_PART), t))
          : Promise.resolve<Text>([false, "", false]),
      ),
    );
  const [o, m] = await read();
  if (d.seq !== seq) return false;
  const step = (): More | undefined => {
    if (!left[0] && !left[1]) return undefined;
    const label = `${bytesText(Math.max(...next))}${size ? ` of ${megabytes(size)}` : ""} shown`;
    if (Math.max(...next) >= HEX_MAX) return { label: `${label}: the hex view stops here` };
    return {
      label,
      // a dump has no newline after its last row
      load: async () => {
        const [o, m] = await read();
        return [[o[1] && `\n${o[1]}`, m[1] && `\n${m[1]}`], step()];
      },
      // only mid-file on both sides: whole rows, and the other side's next part may hold their twins
      back: (side, bytes) => left[0] && left[1] && ((next[side] -= bytes), (d.more = step()), true),
    };
  };
  Object.assign(d, { listing: { symbols, object: o[0] || m[0] }, shown: [o[1], m[1]], more: step(), same: d.orig.exists === d.mod.exists && o[1] === m[1] && !o[2] && !m[2] });
  return true;
}

/** A hex dump's last rows on one side only, likely moved by bytes added or removed before them: read again with the next part, where their twins come. */
async function alignTail(d: NonNullable<typeof diffFile>) {
  const last = editor().getLineChanges()?.slice(-1)[0];
  if (diffFile !== d || !d.more?.back || !diffView || !last) return;
  const models = [diffView.model.original, diffView.model.modified];
  const [side, from] =
    !last.modifiedEndLineNumber && last.originalEndLineNumber === models[0].getLineCount() ? [0, last.originalStartLineNumber]
    : !last.originalEndLineNumber && last.modifiedEndLineNumber === models[1].getLineCount() ? [1, last.modifiedStartLineNumber]
    : [-1, 0];
  const m = models[side], rows = m ? m.getLineCount() - from + 1 : 0;
  if (!m || from < 2 || !d.more.back(side, rows * 16)) return;
  // with the newline before them
  const range = new monaco.Range(from - 1, m.getLineMaxColumn(from - 1), m.getLineCount(), m.getLineMaxColumn(m.getLineCount()));
  const cut = m.getValueInRange(range).length;
  m.applyEdits([{ range, text: "" }]);
  d.shown![side] = d.shown![side].slice(0, d.shown![side].length - cut);
  await diffDrawn();
}

// git's hunk headers: old start, old count, new start, new count
type Hunk = [number, number, number, number];

/** Big text diff `d`'s first part, and the loader of the next ones: its sides cut where they line up, by git's own diff of them. */
async function loadParts(d: NonNullable<typeof diffFile>) {
  type Part = [string, number, number, boolean];
  const sides = sideSources(d.kind, d.f, d.c), size = Math.max(d.orig.large ?? 0, d.mod.large ?? 0), seq = d.seq;
  // past git's core.bigFileThreshold (512 MB by default) its diff is "Binary files differ", and an LFS file's is its pointers': the sides are cut at the same line
  const hunks = d.orig.exists && d.mod.exists && size <= 512 << 20 && !d.orig.lfs && !d.mod.lfs ? await run<Hunk[]>("diff_hunks", { sides }).catch((): Hunk[] => []) : [];
  // per side: lines and bytes taken so far, and whether it ended
  const lines = [0, 0], bytes = [0, 0], end = [!d.orig.exists, !d.mod.exists];
  const read = (i: number, count: number | undefined, budget: number) =>
    end[i] ? Promise.resolve<Part>(["", 0, 0, true]) : run<Part>("text_part", { at: sides[i][0], path: sides[i][1], offset: bytes[i], lines: count ?? null, budget });
  // the next part, or up to the new side's line `until`
  const next = async (until?: number): Promise<[string, string]> => {
    const budget = until ? JUMP : PART;
    let o = await read(0, until && lineUp(hunks, until, 1) - lines[0], budget);
    // the new side's lines that go with the old side's part; all that is left once the old side ends
    const to = end[0] || o[3] ? Infinity : lineUp(hunks, lines[0] + o[2], 0);
    const m = await read(1, to === Infinity ? undefined : to - lines[1], budget);
    // the new side's part filled up first: the old side cut back to where they line up
    if (to !== Infinity && !m[3] && lines[1] + m[2] < to) o = await read(0, lineUp(hunks, lines[1] + m[2], 1) - lines[0], budget);
    [o, m].forEach(([, n, k, done], i) => ((bytes[i] += n), (lines[i] += k), (end[i] ||= done)));
    return [o[0], m[0]];
  };
  const step = (): More | undefined =>
    end[0] && end[1]
      ? undefined
      : {
          label: `${megabytes(Math.max(...bytes))} of ${megabytes(size)} shown`,
          load: async (until) => {
            const part = await next(until);
            return [part, step()];
          },
          // with some lines after it
          change: hunks.map((h) => h[2] + Math.max(h[3], 1) + 20).find((e) => e - 20 > lines[1]),
        };
  const shown = await next();
  if (d.seq !== seq) return false;
  Object.assign(d, { shown, same: false, more: step() });
  return true;
}

/** The lines of the other side that go with the first `n` of side `from` (0 old, 1 new): shifted by the hunks before, in proportion inside one. */
function lineUp(hunks: Hunk[], n: number, from: 0 | 1) {
  let shift = 0;
  for (const h of hunks) {
    const [start, count, start2, count2] = from ? [h[2], h[3], h[0], h[1]] : h;
    // 0-based first lines; a side with none sits after its start
    const [at, at2] = [count ? start - 1 : start, count2 ? start2 - 1 : start2];
    if (n <= at) break;
    if (n < at + count) return at2 + Math.floor(((n - at) * count2) / count);
    shift = at2 + count2 - (at + count);
  }
  return n + shift;
}

/** The open file's next part, added at the end of both sides. */
async function loadMore(d: NonNullable<typeof diffFile>, until?: number) {
  const more = d.more, seq = d.seq;
  if (!more?.load || d.loading) return;
  d.loading = true;
  try {
    const [part, next] = await busy(more.load(until));
    // the view switched or reloaded meanwhile: the part was for the one before
    if (diffFile !== d || d.seq !== seq || !diffView) return;
    d.more = next;
    d.shown = [d.shown![0] + part[0], d.shown![1] + part[1]];
    // a cursor at the end would move along with the text added there
    const eds = [editor().getOriginalEditor(), editor().getModifiedEditor()], at = eds.map((e) => e.getSelections());
    // the File view's one text takes the new side's part; the old one's waits in shown
    [diffView.model.original, diffView.model.modified].forEach((m, i) => (i || m !== diffView!.model.modified) && m.applyEdits([{ range: m.getFullModelRange().collapseToEnd(), text: part[i] }]));
    eds.forEach((e, i) => at[i] && e.setSelections(at[i]!));
    fitLineNumbers();
    // both sides had ended, or the File view shows no diff: none comes to redraw the bar
    if (fileView() || (!part[0] && !part[1])) return updateHunkBars();
    const drawn = diffDrawn(fullText() ? 300_000 : 500);
    drawn.landed.then(() => alignTail(d));
    await drawn;
  } catch (e) {
    say(String(e), true);
  } finally {
    d.loading = false;
  }
}

/** The next change, loading up to the next one git saw when the loaded part has none left below. */
export async function nextChange() {
  const d = diffFile;
  // a load under way already goes somewhere; the File view has no changes to step to
  if (!d || d.loading || fileView()) return;
  // the loaded part's own changes first: none are known before its diff
  if (!editor().getLineChanges()) await diffView?.waitForDiff();
  const at = editor().getModifiedEditor().getPosition()?.lineNumber ?? 0, ahead = () => (editor().getLineChanges() ?? []).some((c) => Math.max(c.modifiedStartLineNumber, 1) > at);
  const shown = () => (d.shown?.[0].length ?? 0) + (d.shown?.[1].length ?? 0);
  for (let was = -1; diffFile === d && d.more?.change && !ahead() && was !== shown(); ) (was = shown()), await loadMore(d, d.more.change);
  editor().goToDiff("next");
}

// a hex dump's line numbers: its rows' offsets
const offset = (n: number) => ((n - 1) * 16).toString(16).padStart(8, "0");

/** The commits a submodule moved between, and what changed in its folder. */
function submoduleCard(path: string, s: SubmoduleChange) {
  const line = (c: SubCommit | null, cls: string) =>
    h("div", { className: `sub-line ${cls}` }, h("code", { textContent: c ? short(c.hash) : "none" }), h("span", { textContent: c ? c.subject || "(not in the submodule's clone)" : "" }));
  const list = (title: string, cs: SubCommit[]) =>
    cs.length ? [h("h4", { textContent: title }), ...cs.map((c) => h("div", { className: "sub-commit" }, h("code", { textContent: short(c.hash) }), h("span", { textContent: c.subject })))] : [];
  const dirty = [s.changed && `${plural(s.changed, "changed file")}`, s.untracked && `${plural(s.untracked, "untracked file")}`].filter(Boolean).join(", ");
  return [
    ...(s.old?.hash === s.new?.hash ? [line(s.new, "")] : [line(s.old, "del"), line(s.new, "add")]),
    ...list(`${plural(s.added.length, "commit")} added`, s.added),
    ...list(`${plural(s.removed.length, "commit")} removed`, s.removed),
    ...(dirty ? [h("p", { textContent: `Uncommitted in the submodule: ${dirty}. Open it to commit them.` })] : []),
    ...(s.initialized ? [h("button", { className: "sub-open", innerHTML: `${svg(ICONS.submodule)}Open submodule`, onclick: () => openSubmodule(path) })] : []),
  ];
}

// shown in krill; other binary files open in their own app
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|avif|pdf)$/i;
// text, also shown drawn when asked
const SVG = /\.svg$/i;
// drawn as a page: HTML as it is, Markdown rendered first
const PAGE = /\.(html?|mdx?)$/i;
const MD = /\.mdx?$/i;
const PDF = /\.pdf$/i;
// text files the switch can also draw: SVG as an image, HTML and Markdown as a page
const DRAWN = /\.(svg|html?|mdx?)$/i;
// raw bytes the window decodes itself, far cheaper than text in the editor: shown unasked up to this
const IMAGE_UNASKED = 50 << 20;
// past this an image is not drawn: decoded at 4 bytes a pixel, a 30000×30000 one would take the window's ~3.6 GB
const MAX_PIXELS = 100e6;

/** An SVG's diff as its text or as drawn, remembered for the next ones. */
export async function setSvgView(view: string) {
  const dirty = !!diffFile?.dirty;
  // the text comes back from the file: edits to it would be lost
  if (!(await confirmDrop())) return;
  // a binary's hex or symbols: a choice of its own
  const key = binaryView ? "bin-view" : "svg-view";
  if (diffFile && binaryView) {
    // another text in the editor: the old one stays on screen until the new one is drawn
    const copy = still($("diff-editor"));
    park();
    store(key, view);
    await paintSides();
    requestAnimationFrame(() => copy?.remove());
  } else if (diffFile) {
    diffFile.dirty = false;
    // the page sides take it as they are made; the text is scrolled before its first frame
    const spot = (readAt = readingAt());
    // its dropped edits are not kept
    if (!dirty) park();
    store(key, view);
    const drawn = paintSides();
    readAt = null;
    const ed = textEditor();
    if (spot && ed) showLine(spot, ed);
    await drawn;
  }
  // the history's File view: showRev only redraws another row; it takes the spot on its way
  else if (hist) {
    store(key, view);
    const at = hist.at;
    hist.at = -1;
    // a hex row and a symbol line are no same place
    readAt = binaryView ? null : readingAt();
    await showRev(at);
    readAt = null;
  }
}

// where a page or its text was read, carried across the Text | Page switch: a source line (Markdown blocks have theirs), else a fraction
type Spot = { line: number; frac: number };
let readAt: Spot | null = null;

/** The text in sight: the history's File view, else the diff's new side. */
const textEditor = () => (hist && !$("hist-file").hidden ? histEd : !$("diff-file").hidden ? fileEd : $("diff-editor").hidden ? null : editor().getModifiedEditor());

/** Where the open file is read: the page's first block in sight, else the editor's top line. */
function readingAt(): Spot | null {
  const page = $("diff-binary").hidden ? null : [...document.querySelectorAll<HTMLIFrameElement>("#diff-binary iframe")].pop()?.contentDocument?.scrollingElement;
  if (page) {
    const block = [...page.querySelectorAll<HTMLElement>("[data-line]")].find((b) => b.getBoundingClientRect().bottom > 0);
    return { line: block ? +block.dataset.line! : 0, frac: page.scrollTop / Math.max(1, page.scrollHeight - page.clientHeight) };
  }
  const ed = textEditor();
  if (!ed) return null;
  const top = ed.getVisibleRanges()[0]?.startLineNumber ?? 1;
  return { line: top, frac: (top - 1) / Math.max(1, (ed.getModel()?.getLineCount() ?? 1) - 1) };
}

/** Editor `ed` scrolled to spot `s`. */
function showLine(s: Spot, ed: Monaco.editor.ICodeEditor = editor().getModifiedEditor()) {
  const n = ed.getModel()?.getLineCount() ?? 1;
  ed.setScrollTop(ed.getTopForLineNumber(s.line || Math.round(s.frac * (n - 1)) + 1));
}

/** Page `doc` scrolled to spot `s`: its block at that line, else as far down. */
function showSpot(doc: Document, s: Spot) {
  const blocks = [...doc.querySelectorAll<HTMLElement>("[data-line]")];
  if (blocks.length) return blocks.filter((b) => +b.dataset.line! <= Math.max(s.line, 1)).pop()?.scrollIntoView({ block: "start" });
  const page = doc.scrollingElement;
  if (page) page.scrollTop = s.frac * (page.scrollHeight - page.clientHeight);
}

/** The text or drawn switch: shown for an SVG, an HTML page or Markdown, the half of its current view lit; for an object file, hex or symbols. */
function paintSvgView(shown: boolean, image: boolean, path: string, binary = false) {
  $("svg-view").hidden = !shown;
  binaryView = binary;
  const [kind, view, label] = binary ? ["", "", "Symbols"] : MD.test(path) ? ["Markdown", "rendered", "Preview"] : PAGE.test(path) ? ["HTML", "as a page", "Page"] : ["SVG", "as image", "Image"];
  const [text, drawn] = document.querySelectorAll<HTMLElement>("[data-svg]");
  text.title = binary ? "Display as a hex dump" : `Display ${kind} as text`;
  drawn.title = binary ? "Display sections and symbols with their sizes" : `Display ${kind} ${view}`;
  text.querySelector("span")!.textContent = binary ? "Hex" : "Text";
  drawn.querySelector("span")!.textContent = label;
  document.querySelectorAll<HTMLElement>("[data-svg]").forEach((b) => b.classList.toggle("on", (b.dataset.svg === "image") === image));
}
// the switch shown is a binary's
let binaryView = false;
const sideName = (at: string) => (at === "WORKTREE" ? "Working tree" : at === "INDEX" ? "Staged" : at === "HEAD" ? "HEAD" : short(at));
const bytesText = (n: number) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : megabytes(n));

/** How a version of `path` is drawn: a PDF in its viewer, a page in a frame, else as an image. */
function sideOf(path: string) {
  if (PDF.test(path)) return pdfSide;
  return PAGE.test(path) ? pageSide : imageSide;
}

/** The open image's old and new versions, side by side. */
function imageSides() {
  const { kind, f, c, orig, mod } = diffFile!;
  const side = sideOf(f.path);
  // the File view's shown version alone: the old one only for a deleted file
  const sides = sideSources(kind, f, c).flatMap(([at, path], i) => ((i ? mod : orig).exists && (i || !mod.exists || !fileView()) ? [side(at, path, i ? "add" : "del")] : []));
  const box = zoomable(h("div", { className: "img-sides" }, ...sides));
  syncPages([...box.querySelectorAll("iframe")]);
  return box;
}

/** The wheel zooms the versions together around the pointer, a drag pans them, a double-click fits them back. */
function zoomable(box: HTMLElement) {
  // a page scrolls itself
  if (box.querySelector("iframe")) return box;
  let z = 1, x = 0, y = 0;
  const label = h("small", { className: "img-zoom" });
  const apply = () => {
    box.style.setProperty("--zoom", `translate(${x}px, ${y}px) scale(${z})`);
    box.classList.toggle("zoomed", z > 1);
    const imgs = [...box.querySelectorAll("img")];
    // past its own size a pixel shows as a square, not a blur
    imgs.forEach((img) => (img.style.imageRendering = z * img.width > img.naturalWidth ? "pixelated" : ""));
    label.textContent = z > 1 && imgs[0]?.naturalWidth ? `${Math.round((100 * z * imgs[0].width) / imgs[0].naturalWidth)}% · Space or double-click to fit` : z > 1 ? "Space or double-click to fit" : "Scroll to zoom";
  };
  box.onwheel = (e) => {
    const frame = (e.target as HTMLElement).closest(".frame");
    if (!frame) return;
    e.preventDefault();
    const r = frame.getBoundingClientRect(), px = e.clientX - r.left - r.width / 2, py = e.clientY - r.top - r.height / 2;
    const to = Math.min(64, Math.max(1, z * Math.exp(-e.deltaY / 500)));
    // the point under the pointer stays under it
    [x, y, z] = to === 1 ? [0, 0, 1] : [px - ((px - x) * to) / z, py - ((py - y) * to) / z, to];
    apply();
  };
  box.onpointerdown = (e) => {
    // a button takes its own click
    if (e.button || z === 1 || (e.target as HTMLElement).closest("button")) return;
    const [x0, y0, cx, cy] = [x, y, e.clientX, e.clientY];
    box.setPointerCapture(e.pointerId);
    box.onpointermove = (m) => ((x = x0 + m.clientX - cx), (y = y0 + m.clientY - cy), apply());
    box.onpointerup = box.onlostpointercapture = () => (box.onpointermove = null);
  };
  box.ondblclick = () => (([x, y, z] = [0, 0, 1]), apply());
  // else the drag picks the picture up to drop it elsewhere
  box.ondragstart = (e) => e.preventDefault();
  box.append(label);
  apply();
  return box;
}

/** Space: zoomed images fit back, as a double-click does; false when none is. */
export function fitImages() {
  const box = document.querySelector<HTMLElement>("#diff-binary .img-sides.zoomed");
  if (!box?.offsetParent) return false;
  box.dispatchEvent(new MouseEvent("dblclick"));
  return true;
}

/** One version of an image at its own size, captioned with its pixel and byte sizes once loaded. */
function imageSide(at: string, path: string, cls = "") {
  const img = h("img", { alt: "" }) as HTMLImageElement, frame = h("div", { className: "frame" }), caption = h("small", { textContent: sideName(at) });
  run<ArrayBuffer>("file_bytes", { at, path }).then(
    (bytes) => {
      // Blob here is git's, from ./repo
      // an SVG draws only with its type; the others are recognised by their bytes
      const url = URL.createObjectURL(new globalThis.Blob([bytes], { type: SVG.test(path) ? "image/svg+xml" : "" }));
      const size = bytesText(bytes.byteLength), pixels = () => (img.naturalWidth ? ` · ${img.naturalWidth}×${img.naturalHeight}` : "");
      // off the page until its size is known: the pixels decode only once drawn
      img.onload = () => {
        URL.revokeObjectURL(url);
        caption.textContent = `${sideName(at)}${pixels()} · ${size}`;
        if (img.naturalWidth * img.naturalHeight <= MAX_PIXELS) return frame.append(img);
        frame.append(h("div", { className: "huge" }, h("span", { textContent: "Image too big to show here" }), openButton(at, path)));
      };
      img.onerror = () => (URL.revokeObjectURL(url), (caption.textContent = `${sideName(at)} · ${size}: cannot be shown`));
      img.src = url;
      untilLoaded(img, "load", "error");
    },
    (e) => (caption.textContent = String(e)),
  );
  return h("figure", { className: `img-side ${cls}` }, frame, caption);
}

/** One PDF version, in the WebView's own viewer. */
function pdfSide(at: string, path: string, cls = "") {
  // no sandbox: it stops the viewer's own scripts; the PDF's never run in the window's origin
  const frame = h("iframe") as HTMLIFrameElement, caption = h("small", { textContent: sideName(at) });
  run<ArrayBuffer>("file_bytes", { at, path }).then(
    (bytes) => {
      const url = URL.createObjectURL(new globalThis.Blob([bytes], { type: "application/pdf" }));
      frame.src = url;
      // WebKitGTK's viewer never fires load: its page holds the viewer's own frame once the PDF is in
      const page = () => frame.contentDocument?.URL.startsWith("blob:") && frame.contentDocument.querySelector("iframe");
      busy(new Promise<void>((done) => {
        // the look stops with the wait, whatever ended it: other viewers have no inner frame
        let over = false;
        const end = () => ((over = true), done());
        frame.addEventListener("load", end, { once: true });
        const look = () => over || (page() || !frame.isConnected ? end() : requestAnimationFrame(look));
        requestAnimationFrame(look);
        setTimeout(end, 10_000);
      }));
      // ponytail: freed once the frame is gone, checked every few seconds; the viewer may read it until then
      const gone = setInterval(() => frame.isConnected || (clearInterval(gone), URL.revokeObjectURL(url)), 3000);
      caption.textContent = `${sideName(at)} · ${bytesText(bytes.byteLength)}`;
    },
    (e) => (caption.textContent = String(e)),
  );
  return h("figure", { className: `img-side ${cls}` }, h("div", { className: "frame page" }, frame), caption);
}

/** Two pages side by side scroll together, as a text diff's sides do. Checked each frame: scripts never run in them, so no scroll event reaches the window either. */
function syncPages(frames: HTMLIFrameElement[]) {
  if (frames.length !== 2) return;
  const last = [0, 0];
  const tick = () => {
    // gone with its diff
    if (!frames[0].isConnected) return;
    const pages = frames.map((f) => f.contentDocument?.scrollingElement);
    if (pages[0] && pages[1]) {
      // the one that moved leads; the one it moves is not taken for a lead the next frame
      const moved = pages.map((p, i) => p!.scrollTop !== last[i]);
      if (moved[0] !== moved[1]) followPage(frames[+moved[1]].contentDocument!, frames[+moved[0]].contentDocument!);
    }
    pages.forEach((p, i) => (last[i] = p?.scrollTop ?? 0));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Page `to` scrolled to where `from` is read: the block in sight there, found unchanged here, at the same height; else as far down. */
function followPage(from: Document, to: Document) {
  // Markdown's source blocks, else the page's own top-level elements
  const blocks = (d: Document) => {
    const tagged = [...d.querySelectorAll<HTMLElement>("[data-line]")];
    return tagged.length ? tagged : ([...d.body.children] as HTMLElement[]);
  };
  const page = to.scrollingElement!, s = from.scrollingElement!;
  const top = blocks(from).find((b) => b.getBoundingClientRect().bottom > 0);
  const twin = top && blocks(to).find((b) => b.textContent === top.textContent);
  if (twin) page.scrollTop += twin.getBoundingClientRect().top - top.getBoundingClientRect().top;
  else page.scrollTop = (s.scrollTop / Math.max(1, s.scrollHeight - s.clientHeight)) * (page.scrollHeight - page.clientHeight);
}

/** One version of an HTML page or a Markdown file, drawn without scripts or anything remote: its own images and stylesheets come from the same version. */
function pageSide(at: string, path: string, cls = "") {
  // its own origin for the window to read its scroll; scripts still never run
  const frame = h("iframe", { sandbox: "allow-same-origin" }) as HTMLIFrameElement, caption = h("small", { textContent: sideName(at) });
  const spot = readAt;
  // out of sight until scrolled there: drawn at its top first, it would jump
  if (spot) frame.style.visibility = "hidden";
  if (spot) frame.onload = () => (frame.contentDocument && showSpot(frame.contentDocument, spot), (frame.style.visibility = ""));
  run<ArrayBuffer>("file_bytes", { at, path }).then(
    async (bytes) => {
      const text = new TextDecoder().decode(bytes);
      const doc = new DOMParser().parseFromString(MD.test(path) ? await markdownPage(text) : text, "text/html");
      // what the scrub below cannot see: a template becomes a live shadow root in the frame, an SVG animation re-arms a link, MathML takes href too
      doc.querySelectorAll("template, animate, set").forEach((e) => e.remove());
      doc.querySelectorAll("math[href], math [href]").forEach((e) => e.removeAttribute("href"));
      await inlineLocal(doc, at, path);
      // a page that turns dark with the desktop gets dark diagrams
      await busy(drawMermaid(doc, MD.test(path) || (matchMedia("(prefers-color-scheme: dark)").matches && /prefers-color-scheme:\s*dark/.test(text)) ? "dark" : "default"));
      // the policy covers loads, not navigation nor prefetches: no refresh, no link left, every link a script the sandbox never runs (still drawn as a link)
      doc.querySelectorAll("base, link, meta[http-equiv='refresh' i]").forEach((e) => e.remove());
      doc.querySelectorAll("a, area").forEach((a) => {
        a.removeAttribute("target");
        a.removeAttributeNS("http://www.w3.org/1999/xlink", "href");
        if (a.hasAttribute("href")) a.setAttribute("href", "javascript:void 0");
      });
      doc.head.prepend(
        h("meta", { httpEquiv: "Content-Security-Policy", content: "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:" }),
        // a browser's light page where the page says nothing, on the body: one on the root would stop the page's own body colour filling the frame; a see-through scrollbar suits light and dark pages
        h("style", {
          textContent:
            ":root { color-scheme: light; } :where(body) { background: #fff; color: #000; } .mermaid-drawn svg { display: block; max-width: 100%; height: auto; margin: 1em auto; } ::-webkit-scrollbar { width: 14px; height: 14px; background: transparent; } ::-webkit-scrollbar-thumb { border: 3px solid transparent; border-radius: 7px; background: #8888 padding-box; } ::-webkit-scrollbar-corner { background: transparent; }",
        }),
      );
      frame.srcdoc = `<!doctype html>${doc.documentElement.outerHTML}`;
      untilLoaded(frame, "load");
      caption.textContent = `${sideName(at)} · ${bytesText(bytes.byteLength)}`;
    },
    (e) => (caption.textContent = String(e)),
  );
  return h("figure", { className: `img-side ${cls}` }, h("div", { className: "frame page" }, frame), caption);
}

// a reading width and GitHub-like type in krill's colours: Markdown has no style of its own
const MD_STYLE =
  ":root { color-scheme: dark; } body { max-width: 860px; margin: 0 auto; padding: 24px 32px; font: 15px/1.6 system-ui, sans-serif; color: #e4e8ef; background: #1b1f27; } h1, h2 { padding-bottom: 0.3em; border-bottom: 1px solid #374050; } a { color: #58a6ff; } img { max-width: 100%; } code, pre { font-family: ui-monospace, Menlo, Consolas, monospace; background: #232832; border-radius: 6px; } code { padding: 0.2em 0.4em; font-size: 85%; } pre { padding: 16px; overflow: auto; } pre code { padding: 0; background: none; } blockquote { margin: 0; padding: 0 1em; color: #8c95a6; border-left: 0.25em solid #374050; } table { border-collapse: collapse; } th, td { padding: 6px 13px; border: 1px solid #374050; } hr { border: 0; border-top: 1px solid #374050; }";

/** The page's mermaid diagrams (Markdown code blocks, HTML `.mermaid` blocks) drawn in place, as SVG. */
async function drawMermaid(doc: Document, theme: string) {
  const blocks = [...doc.querySelectorAll("pre.mermaid, div.mermaid, pre > code.language-mermaid")];
  if (!blocks.length) return;
  const draw = await mermaidDrawer();
  for (const b of blocks) {
    // both versions of a page, or the same page again, share their drawings; ponytail: dropped all at once past 100
    const key = `${theme}\n${b.textContent}`;
    if (drawings.size > 100) drawings.clear();
    if (!drawings.has(key)) drawings.set(key, draw(b.textContent ?? "", theme));
    const svg = await drawings.get(key);
    if (svg) (b.tagName === "CODE" ? b.parentElement! : b).outerHTML = `<div class="mermaid-drawn">${svg}</div>`;
  }
}

const drawings = new Map<string, Promise<string | null>>();

// the library runs in a frame of its own, loaded once: scripts but no origin and no network, so a file's text never runs where git does
let drawer: Promise<(code: string, theme: string) => Promise<string | null>> | null = null;
function mermaidDrawer() {
  return (drawer ??= import("mermaid/dist/mermaid.min.js?raw").then(
    ({ default: lib }) =>
      new Promise((done) => {
        // laid out, as the library measures its text; in the viewport but see-through and under the window: WebKit slows a frame out of view to 2 s a diagram
        const frame = h("iframe", { sandbox: "allow-scripts", style: "position: fixed; left: 0; top: 0; width: 1200px; height: 900px; opacity: 0; pointer-events: none; z-index: -1" }) as HTMLIFrameElement;
        const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";
        frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><body><script>
onmessage = async ({ data }) => {
  // a script of its own: the library is strict, an eval would keep its globals to itself
  if (typeof data === "string") return document.body.append(Object.assign(document.createElement("script"), { textContent: data })), parent.postMessage(["loaded"], "*");
  const [id, code, theme] = data;
  try {
    // flat boxes: version 12's themes add gradient borders and a grey shadow
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme, themeVariables: { useGradient: false, dropShadow: "none" } });
    parent.postMessage([id, (await mermaid.render("m" + id, code)).svg], "*");
  } catch {
    parent.postMessage([id, null], "*");
  }
};
parent.postMessage(["ready"], "*");
</script>`;
        const waiting = new Map<number, (svg: string | null) => void>();
        let seq = 0;
        addEventListener("message", ({ source, data }) => {
          if (source !== frame.contentWindow || !Array.isArray(data)) return;
          const [id, svg] = data;
          if (id === "ready") return frame.contentWindow!.postMessage(lib, "*");
          // a diagram that never settles is left undrawn after 10 s
          if (id === "loaded")
            return done(
              (code: string, theme: string) =>
                new Promise((back) => {
                  const n = ++seq;
                  waiting.set(n, back);
                  frame.contentWindow!.postMessage([n, code, theme], "*");
                  setTimeout(() => (waiting.get(n)?.(null), waiting.delete(n)), 10_000);
                }),
            );
          waiting.get(id)?.(svg);
          waiting.delete(id);
        });
        document.body.append(frame);
      }),
  ));
}

/** A Markdown file as an HTML page, with the parser Monaco carries; each block tagged with its first source line. */
async function markdownPage(text: string) {
  const { lexer, parser } = await import("monaco-editor/esm/vs/base/common/marked/marked.js");
  // front matter is for a site generator, not for reading
  const front = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)?.[0] ?? "";
  let line = 1 + (front.match(/\n/g)?.length ?? 0);
  const blocks = lexer(text.slice(front.length), { gfm: true }).map((t) => {
    const at = line;
    line += t.raw.match(/\n/g)?.length ?? 0;
    return t.type === "space" ? "" : `<div data-line="${at}">${parser([t], { gfm: true })}</div>`;
  });
  return `<style>${MD_STYLE}</style>${blocks.join("")}`;
}

/** The page's own images and stylesheets, read from version `at` in place of their links; remote ones stay out. */
async function inlineLocal(doc: Document, at: string, path: string) {
  // relative to the page, or to the repository's root for a leading /
  const base = `file:///${encodeURI(path).replace(/[?#]/g, encodeURIComponent)}`;
  const local = (url: string | null) => {
    if (!url || /^([a-z][\w+.-]*:|\/\/|#)/i.test(url)) return null;
    const p = new URL(url, base).pathname.slice(1);
    // a bare % in a name is no escape: a browser asks for the name as written
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  };
  const bytes = (p: string) => run<ArrayBuffer>("file_bytes", { at, path: p }).catch(() => null);
  // a video stays out, its poster is an image
  const images = [...doc.querySelectorAll("img, video[poster]")].map(async (el) => {
    const attr = el.tagName === "VIDEO" ? "poster" : "src";
    el.removeAttribute("srcset");
    const p = local(el.getAttribute(attr)), b = p && (await bytes(p));
    if (b) el.setAttribute(attr, await dataUrl(b, SVG.test(p) ? "image/svg+xml" : ""));
  });
  const sheets = [...doc.querySelectorAll("link[rel~='stylesheet' i]")].map(async (link) => {
    const p = local(link.getAttribute("href")), b = p && (await bytes(p));
    link.replaceWith(...(b ? [h("style", { textContent: new TextDecoder().decode(b) })] : []));
  });
  await Promise.all([...images, ...sheets]);
}

const dataUrl = (bytes: ArrayBuffer, type: string) =>
  new Promise<string>((done) => {
    const r = new FileReader();
    r.onload = () => done(String(r.result));
    // Blob here is git's, from ./repo
    r.readAsDataURL(new globalThis.Blob([bytes], { type }));
  });

/** Download the open diff's LFS versions from the remote, then show them. */
function lfsFetchButton() {
  const d = diffFile!;
  // uncommitted versions are local once staged: what can be missing comes with HEAD
  const revs = d.kind === "commit" ? [d.c!.hash, ...d.c!.parents.slice(0, 1)].filter((r) => r !== "WORKTREE") : ["HEAD"];
  const fetchLfs = async () => {
    if (!(await gitOp("lfs-fetch", [revs.join(" "), [d.f.path, d.f.old].filter(Boolean).join(",")], false)) || diffFile !== d) return;
    const sides = await fetchSides(d.kind, d.f, d.c, d.full).catch((e) => void say(String(e), true));
    if (diffFile !== d || !sides) return;
    const [orig, mod] = sides;
    Object.assign(d, { orig, mod, same: alike(orig, mod), listing: undefined, shown: undefined, more: undefined }), dropParked();
    paintSides();
  };
  return h("button", { className: "lfs-fetch", innerHTML: `${svg(ICONS.load)}Download from LFS`, onclick: fetchLfs });
}

/** Open version `at` of `path` in the desktop's app for its type. */
function openButton(at: string, path: string) {
  return h("button", { className: "open-default", innerHTML: `${svg(ICONS.external)}Open in default program`, onclick: () => openVersion(at, path) });
}

const openVersion = (at: string, path: string) => (say(`Opening ${basename(path)}…`), run("open_version", { at, path }).catch((e) => say(String(e), true)));

// a binary, pictures too, opens in its own app: no text to edit
const inApp = (d: NonNullable<typeof diffFile>) => d.orig.binary || d.mod.binary;

/** The diff bar's Open: a binary's version shown, in its default program; else the working tree file in the editor set in Settings, at the cursor's line. */
export function openDiffFile() {
  const d = diffFile;
  if (!d) return;
  if (inApp(d)) return void openVersion(...sideSources(d.kind, d.f, d.c)[d.mod.exists ? 1 : 0]);
  openInEditor(d.f.path, (textEditor() ?? editor().getModifiedEditor()).getPosition()?.lineNumber ?? 1).catch((e) => say(String(e), true));
}

function forceLoadButton(bytes: number) {
  const b = h("button", { className: "force-load", innerHTML: `${svg(ICONS.load)}Force load`, onclick: loadFull });
  b.dataset.tip = bytes > MAX_ASKED ? `Can't load files over ${megabytes(MAX_ASKED)}` : "Force loading will block the interface for up to 30 sec";
  b.classList.toggle("off", bytes > MAX_ASKED);
  return b;
}

/** Load the open diff's big file in full, the window waiting under a spinner. */
async function loadFull() {
  const d = diffFile!;
  await whileLoading(`Loading ${basename(d.f.path)}…`, async (gaveUp) => {
    const [orig, mod] = await fetchSides(d.kind, d.f, d.c, true);
    if (diffFile !== d || gaveUp()) return;
    Object.assign(d, { orig, mod, full: true });
    await paintSides();
  });
}

function paintOpenEditor() {
  if (!diffFile) return;
  const { f } = diffFile;
  // a file from another branch may not be on disk: say so on the button, not as an error
  const ed = $("open-editor");
  if (inApp(diffFile)) {
    ed.classList.remove("off");
    ed.title = `Open this version (${sideName(sideSources(diffFile.kind, f, diffFile.c)[diffFile.mod.exists ? 1 : 0][0])}) in its default program`;
    return;
  }
  run<boolean>("on_disk", { path: f.path }).then((ok) => {
    if (diffFile?.f.path !== f.path) return;
    ed.classList.toggle("off", !ok);
    ed.title = ok ? "Open the working tree file in the editor set in Settings" : `${f.path} is not in the working tree (not on the checked out branch)`;
  });
}

/** A first diff of two tiny models, owned like any other so the next one frees it. */
export async function warmDiff() {
  const lines = Array.from({ length: 600 }, (_, i) => `    value_${i} = compute(${i * 7 % 13}, "${i}");`);
  const changed = lines.map((l, i) => (i % 25 ? l : `${l} // ${i}`));
  diffView = editor().createViewModel({ original: newModel(lines.join("\n"), "a.c"), modified: newModel(changed.join("\n"), "b.c") });
  // drawn once out of sight: Monaco's first render made the first file shown slower
  const pane = $("diff");
  pane.classList.add("blank");
  pane.hidden = false;
  editor().setModel(diffView);
  await diffDrawn();
  pane.classList.remove("blank");
  // a file opened meanwhile keeps its pane
  if (!diffFile) pane.hidden = true;
}

/** The open diff's text in the editor, a kept view if it has one; whether it did, its diff done already. */
function setModels(keepView: boolean) {
  if (!diffFile) return false;
  const ed = editor();
  const view = keepView ? ed.saveViewState() : null, fileAt = keepView ? fileEd?.saveViewState() : null;
  const prev = diffView, back = parked.get(viewKey());
  const [o, m] = diffFile.shown ?? [diffFile.orig.text, diffFile.mod.text];
  parked.delete(viewKey());
  const modified = back?.view.model.modified ?? newModel(m, `b/${diffFile.f.path}`);
  // Monaco 0.52 never disposes a view model it makes from bare models, nor the files it holds
  diffView = back?.view ?? ed.createViewModel({ original: collapsed() ? modified : newModel(o, `a/${diffFile.f.path}`), modified });
  ed.setModel(diffView);
  if (prev) freeView(prev);
  // a view kept aside from the other one
  fitOriginal();
  const editable = isEditable(), hex = isHex();
  // greyed until an edit: always there, the bar does not shift
  $("diff-editable").hidden = $("diff-save").hidden = !editable;
  ($("diff-save") as HTMLButtonElement).disabled = !diffFile.dirty;
  setOptions({ readOnly: !editable, glyphMargin: diffFile.kind !== "commit" && !diffFile.shown, lineNumbers: hex ? offset : "on" });
  fitLineNumbers();
  paintFile();
  if (fileAt) fileEd?.restoreViewState(fileAt);
  // a read-only side changes only by the parts added to it; a kept model has its listener
  const d = diffFile;
  if (!back)
    modified.onDidChangeContent(() => {
      if (diffFile !== d || !editable) return;
      diffFile.dirty = true;
      ($("diff-save") as HTMLButtonElement).disabled = false;
    });
  if (view ?? back?.at) ed.restoreViewState(view ?? back!.at);
  return !!back;
}

/** Line numbers wide enough for the longest with a space to spare: Inline puts both sides' side by side. */
function fitLineNumbers() {
  const m = diffView?.model, digits = m ? String(Math.max(m.original.getLineCount(), m.modified.getLineCount())).length : 0;
  setOptions({ lineNumbersMinChars: isHex() ? 9 : Math.max(5, digits + 1) });
}

// the working tree file as it is: typed in, then saved
const isEditable = () => !!diffFile && diffFile.kind === "unstaged" && diffFile.mod.exists && !diffFile.shown;
// a binary's hex dumps: its lines numbered by offset
const isHex = () => !!diffFile?.listing && !(diffFile.listing.symbols && diffFile.listing.object);

/** The File view's editor on the open diff's own text, edits and all: its new side, the old one when gone. */
function paintFile() {
  const v = diffView;
  if (!diffFile || !v || !fileView()) return void fileEd?.setModel(null);
  if (!fileEd) {
    fileEd = monaco.editor.create($("diff-file"), { ...plainOpts(), wordWrap, minimap: { renderCharacters: false, showSlider: "always" } });
    // Monaco takes the clicks on its zones: the bar loads the next part from anywhere on it
    fileEd.onMouseDown((e) => e.target.type === monaco.editor.MouseTargetType.CONTENT_VIEW_ZONE && e.target.detail.viewZoneId === fileMore && diffFile && loadMore(diffFile));
    revealMoreBar(fileEd);
    fileEd.onDidLayoutChange(fitHunkBars);
  }
  fileEd.updateOptions({ readOnly: !isEditable(), lineNumbers: isHex() ? offset : "on", lineNumbersMinChars: isHex() ? 9 : 5 });
  fileEd.setModel(diffFile.mod.exists ? v.model.modified : v.model.original);
}

/** The open WIP file's row in its list, for the file after it to take over if it leaves. */
export const openRow = () => (diffFile && diffFile.kind !== "commit" ? (fileLists.get($(diffFile.kind))?.order.findIndex((x) => x.path === diffFile!.f.path) ?? -1) : -1);

/** The open file left its list: the file now in its `row`, else the file's other side, else nothing. */
function moveOn(kind: "staged" | "unstaged", f: Change, row: number) {
  const order = fileLists.get($(kind))?.order ?? status![kind], at = Math.max(row, 0);
  // the change now in its place, else the one before: All files' unchanged rows are no change to move on to
  const next = order.slice(at).find((x) => x.code) ?? order.slice(0, at).reverse().find((x) => x.code);
  const other = kind === "staged" ? "unstaged" : "staged", same = status![other].find((x) => x.path === f.path);
  return next ? openDiff(kind, next) : same ? openDiff(other, same) : closeDiff();
}

/** Refresh the open diff; `row` is where its WIP file was before the lists changed. */
export async function reloadDiff(row = -1) {
  const d = diffFile;
  if (!d || d.dirty || !status) return;
  const { kind, f } = d;
  const listed = kind !== "commit" && status[kind].find((x) => x.path === f.path);
  const onWip = selection.hashes[0] === "WIP" && !selection.stash;
  // changed back to as it was, not staged: All files still lists it, so it stays open, whole again
  const back = kind === "unstaged" && !listed && !!f.code && !!document.querySelector(".all-files.on") && onWip && !status.staged.some((x) => x.path === f.path);
  // an All files entry belongs to the WIP panel: gone with it, as a commit moves on to HEAD
  if (kind === "unstaged" && !listed && !f.code && !onWip) return closeDiff();
  // an All files entry was never listed: it stays open, unchanged or not yet
  if (kind !== "commit" && !listed && f.code && !back) return moveOn(kind, f, row);
  // the file may have changed status code
  if (listed) d.f = listed;
  else if (back) d.f = { path: f.path, old: null, code: "" };
  // a commit's sides never change, the uncommitted row of a file history aside; an All files entry reads its file again below
  else if (kind === "commit" && d.c?.hash !== "WORKTREE") return paintOpenEditor();
  if (d.sub) {
    const sub = await submoduleChange(d.kind, d.f, d.c).catch(() => d.sub);
    if (diffFile !== d || JSON.stringify(sub) === JSON.stringify(d.sub)) return;
    d.sub = sub;
    return paintSides();
  }
  // nothing changed: nothing read, a file loaded on request is hundreds of MB
  const ids = await versionIds(d.kind, d.f, d.c);
  if (diffFile !== d || d.dirty) return;
  if (ids && ids === d.ids) return paintOpenEditor();
  const [orig, mod] = await fetchSides(d.kind, d.f, d.c, d.full);
  // another file opened meanwhile, or edits began
  if (diffFile !== d || d.dirty) return;
  // a new file discarded, or an All files entry a checkout took away, is gone: nothing to stay on
  if (kind !== "commit" && (back || !f.code) && !orig.exists && !mod.exists) return moveOn(kind, f, row);
  d.ids = ids;
  paintOpenEditor();
  // an image has no text to compare: its new version is drawn
  if (alike(orig, d.orig) && alike(mod, d.mod)) return;
  // once saved with a change, its hunks show again
  Object.assign(d, { orig, mod, same: alike(orig, mod), listing: undefined, shown: undefined, more: undefined }), dropParked();
  // no text before or now: its pane is painted again
  if (($("diff-editor").hidden && $("diff-file").hidden) || orig.binary || mod.binary || orig.large || mod.large) return paintSides();
  // the old text stays on screen until the new one is drawn
  const gen = opening, copy = still($(fileView() ? "diff-file" : "diff-editor"));
  dimDiffOpts(false);
  applyMode();
  setModels(true);
  // changed back to as it was: nothing left to compare, the File view
  $("diff-editor").hidden = fileView();
  $("diff-file").hidden = !fileView();
  await diffDrawn();
  // a file opened meanwhile took the copy over
  requestAnimationFrame(() => gen === opening && copy?.remove());
}

/** The text diff's models freed: a file loaded on request can be hundreds of MB. */
function dropModels() {
  if (!diffView) return;
  editor().setModel(null);
  freeView(diffView);
  diffView = null;
}

function freeView(v: Monaco.editor.IDiffEditorViewModel) {
  v.dispose();
  if (v.model.original !== v.model.modified) v.model.original.dispose();
  v.model.modified.dispose();
}

// the open file's text views left for its other view (hex, symbols, text), each with what it had loaded: back to it, Monaco's diff is not done again
const parked = new Map<string, { view: Monaco.editor.IDiffEditorViewModel; at: Monaco.editor.IDiffEditorViewState | null; state: { listing?: Listing; shown?: [string, string]; more?: More; same: boolean } }>();
const viewKey = () => (binaryView ? (store("bin-view") === "text" ? "hex" : "symbols") : "text");

/** The open diff's text view kept aside, the editor emptied. */
function park() {
  const d = diffFile;
  if (!d || !diffView) return;
  const old = parked.get(viewKey());
  if (old) freeView(old.view);
  parked.set(viewKey(), { view: diffView, at: editor().saveViewState(), state: { listing: d.listing, shown: d.shown, more: d.more, same: d.same } });
  editor().setModel(null);
  diffView = null;
}

/** The kept views freed: another file, or this one changed. */
function dropParked() {
  parked.forEach((p) => freeView(p.view));
  parked.clear();
}

export async function closeDiff(force = false) {
  if (!force && diffFile?.dirty && !(await ask(`Drop unsaved edits to ${diffFile.f.path}?`, "Drop edits"))) return;
  dropParked();
  diffFile = null;
  $("diff").hidden = true;
  // the history's file view keeps this bar: its versions are not editable
  $("diff-editable").hidden = $("diff-save").hidden = true;
  dropModels();
  markOpenFile();
}

export async function save() {
  // only the working tree file as it is, never a part or a listing of it
  if (!diffFile?.dirty || diffFile.kind !== "unstaged" || diffFile.shown) return;
  const text = editor().getModifiedEditor().getModel()!.getValue(monaco.editor.EndOfLinePreference.TextDefined, true);
  try {
    await run("write_file", { path: diffFile.f.path, text });
  } catch (e) {
    return say(String(e), true);
  }
  diffFile.mod.text = text;
  diffFile.dirty = false;
  ($("diff-save") as HTMLButtonElement).disabled = true;
  say(`saved ${diffFile.f.path}`);
  // saved with a change, a file opened unchanged gets its Diff view; saved back, it shows alone: under a still copy, in one step
  if (diffFile.same !== (text === diffFile.orig.text && diffFile.orig.exists)) {
    diffFile.same = !diffFile.same;
    const copy = still($("diff-editor"));
    layOutView();
    // computed as it was typed: no new diff to wait for, unless the save beat it
    diffView?.waitForDiff().then(() => requestAnimationFrame(() => copy?.remove()));
  }
}

/** Changed lines under the selection of the side that had focus last. */
function selectedLines(): Lines {
  const fromOrig = lastSide === "orig" && viewMode() === "split";
  const side = fromOrig ? editor().getOriginalEditor() : editor().getModifiedEditor();
  const sel = new Set<number>();
  for (const s of side.getSelections() ?? []) {
    // a drag ending at column 1 does not take that line
    const end = s.endLineNumber > s.startLineNumber && s.endColumn === 1 ? s.endLineNumber - 1 : s.endLineNumber;
    for (let l = s.startLineNumber; l <= end; l++) sel.add(l);
  }
  return pickLines(lineChanges(), sel, fromOrig);
}

const minus = (a: Set<number>, b: Set<number>) => new Set([...a].filter((x) => !b.has(x)));

// a pick of unchanged lines: nothing to do, not a failure
const noLines = () => toast("No changed line picked", "Put the cursor on a changed line, or select some.", "info");

async function applyLines(pick: Lines, action: "stage" | "unstage" | "discard") {
  if (!diffFile) return;
  if (!pick.removed.size && !pick.added.size) return noLines();
  await save();
  const { f, orig, mod } = diffFile;
  const ch = lineChanges(), all = allLines(ch);
  const whole = pick.removed.size === all.removed.size && pick.added.size === all.added.size;
  const keep = () => applyChanges(orig.text, mod.text, ch, minus(all.removed, pick.removed), minus(all.added, pick.added));
  if (action === "discard") return discard([f], whole ? undefined : keep());
  if (whole) {
    await gitOp(action, f.path);
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

export const confirmDiscard = (files: Change[], staged = false) =>
  ask(
    `Discard all changes to ${files.length === 1 ? files[0].path : plural(files.length, "file")}?${staged ? " Staged and unstaged, back to HEAD." : ""}${staged && files.some((f) => ["A", "R", "C"].includes(f.code)) ? " Files HEAD lacks are deleted." : ""}`,
    "Discard",
  ).then((ok) =>
    ok ? discard(files, undefined, staged) : undefined,
  );

/** Discard `files` back to the index, `staged` ones back to HEAD, or the one file to `text` for some of its lines; undone by writing the old texts back. */
export async function discard(files: Change[], text?: string, staged = false) {
  const t = tabs[active], r = repo;
  const read = () =>
    Promise.all(files.map((f) => run<Blob>("blob", { at: "WORKTREE", path: f.path }).then((b) => (b.binary || b.large ? undefined : b.exists ? b.text : null), () => undefined)));
  const paths = (untracked: boolean) => files.filter((f) => (f.code === "?") === untracked).map((f) => f.path);
  const before = await read();
  // the write is for the tab it was asked in
  if (repo !== r) return;
  if (text !== undefined) await run("write_file", { path: files[0].path, text }).then(() => say(`discarded lines of ${files[0].path}`), (e) => say(String(e), true));
  // a rename's old name comes back too
  else if (staged) await gitOp("discard-staged", files.flatMap((f) => (f.old ? [f.path, f.old] : [f.path])).join("\0"));
  else {
    if (paths(false).length) await gitOp("discard", paths(false).join("\0"));
    if (paths(true).length) await gitOp("clean", paths(true).join("\0"));
  }
  const after = await read();
  await refresh();
  // a binary file has no text to put back
  const undo = files.flatMap((f, i): [string, string | null, string | null][] => (before[i] === undefined || after[i] === undefined || before[i] === after[i] ? [] : [[f.path, before[i]!, after[i]!]]));
  if (!undo.length || repo !== r) return;
  const head = headHash(), branch = status?.branch ?? "";
  recordUndo(t, { op: "discard", what: undo.length === 1 ? basename(undo[0][0]) : plural(undo.length, "file"), branch: [branch, branch], head: [head, head], files: undo });
}

/* merge tool */

type Chunk = ReturnType<typeof parseConflicts>[number];
type Conflict = Exclude<Chunk, string[]>;
type Side = "a" | "b";
// a picked line: its side and its index in that side's conflict lines, -1 taking an empty side
type Pick = [Side, number];
// the file in the merge tool: its diff3 chunks, the sides picked per conflict in click order,
// each conflict's lines in the two side panes, and its tracked range in the output
// hover: the side line under the mouse, as "a:12"
export let merging: { f: Change; chunks: Chunk[]; picks: Pick[][]; spans: { a: number[]; b: number[] }[]; ids: string[]; at: number; dirty: boolean; hover: string } | null = null;
let mergeEds: {
  a: Monaco.editor.IStandaloneCodeEditor;
  b: Monaco.editor.IStandaloneCodeEditor;
  out: Monaco.editor.IStandaloneCodeEditor;
  marks: Map<Monaco.editor.IStandaloneCodeEditor, Monaco.editor.IEditorDecorationsCollection>;
} | null = null;

const conflictsOf = (chunks: Chunk[]) => chunks.filter((c): c is Conflict => !Array.isArray(c));
const lineSpan = ([s, n]: number[]) => new monaco.Range(s, 1, s + n, 1);
// a conflict's box sits at the middle of its lines (class half: between the two middle ones), or on the line after an empty side
const boxLine = (ed: Monaco.editor.ICodeEditor, [s, n]: number[]) => Math.min(n ? s + Math.floor((n - 1) / 2) : s, ed.getModel()!.getLineCount());
// NeverGrowsWhenTypingAtEdges, by value: Monaco is not loaded when this runs
const tracked = { stickiness: 1 as Monaco.editor.TrackedRangeStickiness };

/** Every editor's options: ours instead of Monaco's context menu, line actions and no command palette. */
const plainOpts = (): Monaco.editor.IStandaloneEditorConstructionOptions => ({
  theme: "krill",
  automaticLayout: true,
  fontFamily: cssVar("--mono"),
  fontSize,
  // a long line's scrollbar, on top of the text: in the height it would land ~200 ms late, once long lines are measured, and move the change marks
  scrollbar: { horizontal: "visible", ignoreHorizontalScrollbarInContentHeight: true },
  padding: { bottom: 14 },
  scrollBeyondLastLine: false,
  stickyScroll: { enabled: false },
  contextmenu: false,
  // the cursor's line, a bar across the scrollbar: noise in a diff
  hideCursorInOverviewRuler: true,
  // each bracket pair's span, a line in its bracket's colour
  guides: { bracketPairs: true },
});

/** The merge tool's three editors, made on first use. */
function mergeEditors() {
  if (mergeEds) return mergeEds;
  // no folding: its arrows would crowd the line buttons; no overview ruler: nothing marks it, its blank strip hid the lines' ends
  const opts = { ...plainOpts(), minimap: { enabled: false }, glyphMargin: true, folding: false, overviewRulerLanes: 0 };
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
        const k = lineIn(side, ln)?.k ?? merging.spans.findIndex((s) => !s[side][1] && boxLine(ed, s[side]) === ln);
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
  out.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => (merging ? saveMerge() : save().then(refresh)));
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
  if (!(await confirmDrop())) return;
  const text = f.conflict === "UU" || f.conflict === "AA" ? await run<Blob>("conflict_text", { path: f.path }).catch(() => null) : null;
  // the open view goes only now, with the next one coming in the same frame: no graph in between
  await closeDiff(true);
  if (!text || text.binary) return closeMerge(true).then(() => conflictBanner(f));
  merging = { f, chunks: parseConflicts(text.text), picks: [], spans: [], ids: [], at: 0, dirty: false, hover: "" };
  $("merge").hidden = false;
  $("m-path").textContent = f.path;
  $("m-a-name").textContent = opInfo?.current ?? "";
  $("m-b-name").textContent = opInfo?.incoming ?? "";
  $("m-a-commit").textContent = opInfo?.currentCommit ?? "";
  $("m-b-commit").textContent = opInfo?.incomingCommit ?? "";
  // a commit off any branch tip: its name is the hash again
  $("m-b-on").hidden = opInfo?.incoming === opInfo?.incomingCommit;
  loadMerge();
  markOpenFile();
}

/** Fill the panes from the chunks, nothing picked: the output holds each conflict's base. */
export function loadMerge() {
  const m = merging!, eds = mergeEditors(), s = mergeSides(m.chunks, []);
  m.picks = s.regions.map(() => []);
  m.spans = s.regions.map((r) => ({ a: r.a, b: r.b }));
  for (const [ed, text, side] of [[eds.a, s.a, "a"], [eds.b, s.b, "b"], [eds.out, s.out, "out"]] as const) {
    const old = ed.getModel();
    ed.setModel(newModel(text, `${side}/${m.f.path}`));
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
export function pickAll(side: Side) {
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
  const reg = (side: string, on = false) => ({ isWholeLine: true, className: `m-tint-${side}${on ? " on" : ""}`, marginClassName: `m-gutter ${side}${on ? " on" : ""}` });
  // an empty side shows as a dashed line where its lines would be
  const span = (from: number, n: number, side: string, glyph?: string) =>
    n ? Array.from({ length: n }, (_, i) => line(from + i, { ...reg(side), glyphMarginClassName: glyph })) : [line(from, { isWholeLine: true, className: "m-gap" })];
  for (const side of ["a", "b"] as const) {
    const ed = eds[side];
    eds.marks.get(ed)!.set(
      m.spans.flatMap((s, k) => {
        const on = hasSide(conflicts[k], m.picks[k], side), picked = pickedOf(m.picks[k], side), [first, n] = s[side];
        // each line: tinted once picked, a check on it, + or − under the mouse
        const lines = Array.from({ length: n }, (_, i) => {
          const taken = picked.has(i), hovered = m.hover === `${side}:${first + i}`;
          const button = hovered ? (taken ? "m-line drop" : "m-line add") : taken ? "m-line on" : "";
          return line(first + i, { ...reg(side, taken), linesDecorationsClassName: button || undefined });
        });
        return [
          ...(n ? lines : span(first, 0, "")),
          line(boxLine(ed, s[side]), {
            glyphMarginClassName: `m-side-box${on ? " on" : ""}${n && n % 2 === 0 ? " half" : ""}`,
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
  $("m-count").textContent = `${plural(m.ids.length, "conflict")}${left ? `, ${left} without a pick` : ""}`;
  for (const side of ["a", "b"] as const) input(`m-all-${side}`).checked = m.picks.length > 0 && m.picks.every((p, k) => hasSide(conflicts[k], p, side));
  $("m-at").textContent = m.ids.length ? `conflict ${m.at + 1} of ${m.ids.length}` : "";
}

export function goConflict(i: number) {
  const m = merging!, eds = mergeEds!;
  if (!m.ids.length) return;
  m.at = (i + m.ids.length) % m.ids.length;
  eds.out.revealLineInCenter(eds.out.getModel()!.getDecorationRange(m.ids[m.at])!.startLineNumber);
  eds.a.revealLineInCenter(m.spans[m.at].a[0]);
  eds.b.revealLineInCenter(m.spans[m.at].b[0]);
  $("m-at").textContent = `conflict ${m.at + 1} of ${m.ids.length}`;
}

/** Write the output and mark the file resolved. */
export async function saveMerge() {
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
  gitOp("stage", m.f.path);
}

/** Close the merge tool once its file is resolved or the merge aborted, here or elsewhere. */
export function closeResolvedMerge() {
  if (merging && !status?.unstaged.some((f) => f.path === merging!.f.path && isConflict(f))) closeMerge(true);
}

export async function closeMerge(force = false) {
  if (!merging) return true;
  if (!force && merging.dirty && !(await ask(`Drop the merge of ${merging.f.path}?`, "Drop"))) return false;
  merging = null;
  $("merge").hidden = true;
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
              : [`${f.path} cannot be merged line by line (${f.lfs ? "stored with Git LFS" : "binary, not UTF-8 or over 10 MB"}).`, [[`Take current (${cur})`, "take-current"], [`Take incoming (${inc})`, "take-incoming"]]];
  showBanner(h("span", { textContent: text }), ...choices.map(([label, o]) => h("button", { textContent: label, onclick: () => (hideBanner(), gitOp(o, f.path)) })));
}

/* file history */

type Blamed = { hash: string; author: string; time: number; summary: string };
// the file's commits newest first, each with the file's name there, the one shown, its blame, whether its text is a hex dump, and the diff it was opened from
export let hist: { path: string; revs: [Commit, Change][]; at: number; blame: Blamed[]; hex?: boolean; from?: { kind: DiffSource; f: Change; c?: Commit } } | null = null;
export let histEd: Monaco.editor.IStandaloneCodeEditor | null = null;
// the diff's File view, and its bar to load the next part of a file shown in parts
let fileEd: Monaco.editor.IStandaloneCodeEditor | null = null, fileMore = "";
let blameHovers: Monaco.editor.IEditorDecorationsCollection | null = null;
// the blame text: subject, two spaces, date
const BLAME_SUBJECT = 28, BLAME_W = BLAME_SUBJECT + 12;
// the blame strips' colors, one class per palette entry
document.head.append(h("style", { textContent: COLORS.map((c, i) => `.blame-c${i} { background: ${c}; }`).join("\n") }));

/** The commits that touched `path`, from HEAD and from `c` when given, with the file at each; uncommitted changes on top. */
export async function openHistory(path: string, c?: Commit) {
  await loadMonaco();
  if (!(await closeMerge())) return;
  let revs: [Commit, Change][];
  try {
    revs = await run<[Commit, Change][]>("file_log", { revs: c ? ["HEAD", c.hash] : ["HEAD"], path });
  } catch (e) {
    return say(String(e), true);
  }
  // closed only now: the graph would show while git log runs
  const from = diffFile ? { kind: diffFile.kind, f: diffFile.f, c: diffFile.c } : undefined;
  await closeDiff();
  if (diffFile) return;
  // the working tree file as a commit on top of HEAD: blob and diff take WORKTREE as a revision
  if (wipFiles().some((f) => f.path === path))
    revs.unshift([fakeCommit("WORKTREE", ["HEAD"], "Uncommitted changes"), { path, old: null, code: "M" }]);
  if (!revs.length) return say(`${path} has no commits yet`);
  hist = { path, revs, at: -1, blame: [], from };
  $("hist-path").textContent = `File history: ${path}`;
  $("hist-list").replaceChildren(
    ...revs.map(([r, f], i) =>
      h("div", { className: "hist-row", title: f.old ? `${f.old} → ${f.path}` : f.path, onclick: () => showRev(i) },
        r.time ? avatar(r.author) : h("span", { className: "avatar wip" }),
        h("div", {}, h("div", { textContent: r.subject }), h("small", { textContent: r.time ? `${dateTimeText(r.time)} by ${r.author}` : "Working tree" })),
        h("code", { textContent: r.time ? short(r.hash) : "" }),
      ),
    ),
  );
  // the history's file and diff show in the diff's pane, next to its list
  $("hist-main").append($("diff"));
  $("hist-main").classList.add("blank");
  $("hist").hidden = false;
  document.body.classList.add("history");
  showRev(Math.max(0, revs.findIndex(([r]) => r.hash === c?.hash)));
}

/** Show the file at the history's `i`th commit, or that commit's diff of it. */
export async function showRev(i: number) {
  const m = hist;
  if (!m || i === m.at || !m.revs[i]) return;
  m.at = i;
  $("hist-list").querySelectorAll(".hist-row").forEach((r, k) => r.classList.toggle("on", k === i));
  $("hist-list").children[i].scrollIntoView({ block: "nearest" });
  const [c, f] = m.revs[i];
  // a submodule has no file to show: its card says what it pointed at
  if (store("hist-view") === "diff" || (f.sub ?? isSubmodule(f.path))) {
    // openDiff closes a diff opened again
    const opening = diffFile?.c?.hash !== c.hash;
    if (opening) await openDiff("commit", f, c, true);
    // back on the shown commit: a diff still loading for another gives way; one open in its File view shows its changes
    else (openSeq++, layOutView());
    if (hist !== m || m.at !== i) return;
    histPane(false);
    // images, a page or a card have no hunks to land; nor a diff that did not open
    const text = !!diffFile && !diffFile.pane;
    return reveal(opening && text ? diffDrawn() : undefined);
  }
  $("diff-path").textContent = `${f.path} · ${short(c.hash)}`;
  // the file shows first, its blame (slower) fills the gutter when it comes
  const blame = run<string>("blame", { at: c.hash, path: f.path }).catch(() => "");
  const blob = await run<Blob>("blob", { at: c.hash, path: f.path }).catch((e) => (say(String(e), true), null));
  // a binary other than an image reads as its hex dump or, an object file, its symbols
  const symbols = store("bin-view") !== "text", listed = !!blob?.binary && blob.exists && blob.lfs !== "missing" && !IMAGE.test(f.path);
  const listing = listed ? await run<[boolean, string, boolean]>("binary_text", { at: c.hash, path: f.path, symbols, offset: 0 }).catch((e): [boolean, string, boolean] => [false, String(e), false]) : null;
  if (hist !== m || m.at !== i) return;
  // only now: until then the version shown before stays, not this pane's last text
  await closeDiff(true);
  histPane(true);
  if (!blob) return reveal();
  m.blame = [];
  m.hex = !!listing && !(symbols && listing[0]);
  // an image, or an SVG or HTML page asked drawn, shows as itself in the diff's binary pane
  const drawable = DRAWN.test(f.path) && blob.exists && !blob.large, image = drawable && store("svg-view") === "image";
  paintSvgView(drawable || !!listing?.[0], image || (!!listing?.[0] && symbols), f.path, listed);
  if (image || (IMAGE.test(f.path) && (blob.binary || PDF.test(f.path)) && blob.lfs !== "missing" && (!blob.large || blob.large <= IMAGE_UNASKED))) {
    $("hist-file").hidden = true;
    $("diff-binary").hidden = false;
    $("diff-binary").classList.add("images");
    $("zoom").classList.add("off");
    $("diff-binary").replaceChildren(zoomable(h("div", { className: "img-sides" }, (PDF.test(f.path) ? pdfSide : PAGE.test(f.path) ? pageSide : imageSide)(c.hash, f.path))));
    return reveal();
  }
  const ed = historyEditor(), view = ed.saveViewState(), old = ed.getModel();
  const text = blob.lfs === "missing" ? "Stored with Git LFS, this version is not downloaded" : listing ? listing[1] + (listing[2] ? "\n… the Diff view shows the rest" : "") : blob.large ? `${megabytes(blob.large)}: too big to show here, the Diff view can load it` : blob.binary ? "Binary or non-UTF-8 file" : blob.exists ? blob.text : `Deleted in ${short(c.hash)}`;
  ed.setModel(newModel(text, `h/${f.path}`));
  old?.dispose();
  // from its page: the same place; another version of the same file: around the same lines
  if (readAt) showLine(readAt, ed);
  else if (view) ed.restoreViewState(view);
  paintBlame();
  reveal();
  const blamed = parseBlame(await blame) as Blamed[];
  // a binary's lines are no rows of its listing
  if (hist !== m || m.at !== i || listing) return;
  // git's zero hash for uncommitted lines: the WIP row
  const wip = blamed.find((b) => b && /^0+$/.test(b.hash));
  if (wip) Object.assign(wip, { hash: "WORKTREE", summary: "Uncommitted changes" });
  m.blame = blamed;
  paintBlame();
}

/** The diff's pane holds the file view too: the bar stays, with the diff options dimmed. */
function histPane(file: boolean) {
  $("diff").hidden = false;
  $("hist-file").hidden = !file;
  if (!file) return;
  $("diff-editor").hidden = $("diff-file").hidden = $("diff-binary").hidden = $("svg-view").hidden = true;
  $("zoom").classList.remove("off");
  // the diff's own state undims them
  dimDiffOpts(true);
  tipDiffOnly(true);
}

const dimDiffOpts = (dim: boolean) =>
  [$("prev-change"), $("next-change"), ...document.querySelectorAll<HTMLElement>("[data-mode], [data-dview]")].forEach((b) => b.classList.toggle("off", dim));

/** Show the history's pane once `drawn` settles, a frame later so it is painted. */
const reveal = (drawn?: Promise<unknown>) => (drawn ?? Promise.resolve()).then(() => requestAnimationFrame(() => $("hist-main").classList.remove("blank")));

// a diff's hunks and folds land a moment after its text: waited for `ms` at most, the busy pointer up until they land or Monaco gives up (5 s)
const diffDrawn = (ms = 500) => {
  const landed = new Promise((done) => {
    const end = (then: () => void) => (d.dispose(), m.dispose(), then());
    // the first update only drops the old diff: wait for one with changes computed, and the frame that draws its deleted lines
    const d = editor().onDidUpdateDiff(() => editor().getLineChanges() && end(() => requestAnimationFrame(done)));
    // another file in its place: its own wait takes over
    const m = editor().onDidChangeModel(() => end(() => done(0)));
    setTimeout(() => end(() => done(0)), Math.max(ms, 5500));
  });
  busy(landed);
  return Object.assign(Promise.race([landed, new Promise((r) => setTimeout(r, ms))]), { landed });
};

/** Busy until `el` fires one of `events`, is taken off the page (a view switch, another file: it never fires then), or 10 s pass. */
const untilLoaded = (el: HTMLElement, ...events: string[]) => {
  let gone = 0;
  const loaded = new Promise<void>((done) => {
    events.forEach((t) => el.addEventListener(t, () => done(), { once: true }));
    gone = setInterval(() => el.isConnected || done(), 250);
    setTimeout(done, 10_000);
  });
  return busy(loaded.finally(() => clearInterval(gone)));
};

function historyEditor() {
  if (histEd) return histEd;
  histEd = monaco.editor.create($("hist-file"), { ...plainOpts(), wordWrap, readOnly: true, minimap: { renderCharacters: false, showSlider: "always" } });
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
export function paintBlame() {
  const m = hist!, on = store("hist-blame") === "on", digits = m.hex ? 8 : String(histEd!.getModel()!.getLineCount()).length;
  // ponytail: Monaco inserts the line number string as HTML, so the gutter is drawn as text; a view zone per line if it starts escaping
  histEd!.updateOptions({
    lineNumbersMinChars: (on ? BLAME_W + 1 : 0) + 4 + digits,
    lineNumbers: (n) => {
      const b = m.blame[n - 1], first = !!b && m.blame[n - 2]?.hash !== b.hash;
      const num = m.hex ? offset(n) : String(n).padStart(digits);
      if (!first) return `<span class="blame-av"></span> ${on ? " ".repeat(BLAME_W + 1) : ""} ${num}`;
      const text = on ? `${b.summary.slice(0, BLAME_SUBJECT).padEnd(BLAME_SUBJECT)}  ${dateText(b.time)} ` : "";
      return `${avatarSvg(b.author, "blame-av")} ${esc(text)} ${num}`;
    },
  });
  // who and when over each run of lines from one commit, and its strip, colored by its row
  const escapeMarkdown = (s: string) => s.replace(/[\\`*_{}[\]()#+\-.!<>|~]/g, "\\$&");
  const color = (hash: string) => {
    const row = m.revs.findIndex(([c]) => c.hash === hash);
    return row < 0 ? colorIndex(hash) : row % COLORS.length;
  };
  blameHovers!.set(
    m.blame.flatMap((b, k) => {
      if (!b || m.blame[k - 1]?.hash === b.hash) return [];
      let end = k;
      while (m.blame[end + 1]?.hash === b.hash) end++;
      const value = `**${escapeMarkdown(b.author)}**, ${dateTimeText(b.time)} · \`${short(b.hash)}\`\n\n${escapeMarkdown(b.summary)}`;
      const options = { lineNumberHoverMessage: { value }, linesDecorationsClassName: `blame-strip blame-c${color(b.hash)}` };
      return [{ range: new monaco.Range(k + 1, 1, end + 1, 1), options }];
    }),
  );
}

/** Blame's three states: on, off, and dimmed in the diff view. */
export function paintBlameBtn() {
  const b = $("hist-blame"), diff = store("hist-view") === "diff", on = store("hist-blame") === "on";
  b.classList.toggle("off", diff);
  b.classList.toggle("on", on && !diff);
  b.title = diff ? "Blame: only in the File view" : on ? "Hide each line's commit" : "Show each line's commit next to it";
}

export function histView(v: string) {
  if (hist && store("hist-view") === v) return;
  store("hist-view", v);
  document.querySelectorAll<HTMLElement>("[data-hview]").forEach((b) => b.classList.toggle("on", b.dataset.hview === v));
  paintBlameBtn();
  if (!hist) return;
  const i = hist.at;
  hist.at = -1;
  $("hist-main").classList.add("blank");
  showRev(i);
}

// true from Esc until the diff a history was opened from is back: a second Esc waits for it, not the next thing Esc closes
export let leavingHistory = false;

/** The history closed by the user: back to the diff it was opened from, if any. */
export async function leaveHistory() {
  if (leavingHistory) return;
  const from = hist?.from;
  // a working tree file since staged, committed or discarded has no such diff left: the graph instead
  const f = from?.kind === "commit" ? from.f : from && status?.[from.kind].find((x) => x.path === from.f.path);
  if (!from || !f) return closeHistory();
  // the history stays in sight until that diff is drawn, not the graph: openDiff takes a still copy over and drops it then
  const r = $("hist").getBoundingClientRect(), copy = still($("hist"))!;
  // fixed over the window: closed, the history gives its width back to the sidebar and the details; its File | Diff switch is the history's own
  Object.assign(copy.style, { position: "fixed", left: `${r.left}px`, top: `${r.top}px` });
  document.body.append(copy);
  copy.querySelector("#diff-view")?.remove();
  leavingHistory = true;
  await closeHistory();
  await openDiff(from.kind, f, from.c).finally(() => (leavingHistory = false));
  // not opened: nothing else takes it down
  if (!diffFile) copy.remove();
}

export async function closeHistory() {
  run("stop_blame");
  await closeDiff(true);
  $("hist-file").hidden = true;
  dimDiffOpts(false);
  hist = null;
  $("hist").hidden = true;
  document.body.classList.remove("history");
  $("merge").before($("diff"));
}

// the text's size, zoomed from the diff's bar
let fontSize = 13;

/** Every editor's text at `size` px. */
export function setFontSize(size: number) {
  fontSize = size;
  for (const ed of [histEd, fileEd, mergeEds?.a, mergeEds?.b, mergeEds?.out]) ed?.updateOptions({ fontSize });
  // through setOptions: Inline's minimap comes back
  if (diffEditor) setOptions({ fontSize });
}

// the merge's panes stay unwrapped: they scroll together line for line
let wordWrap: "on" | "off" = "off";

/** The diff's and the history's long lines wrapped, or not. */
export function setWordWrap(on: boolean) {
  wordWrap = on ? "on" : "off";
  for (const ed of [histEd, fileEd]) ed?.updateOptions({ wordWrap });
  if (diffEditor) setOptions({ wordWrap });
}

/** Lay the shown editors out now: Monaco's own resize handling waits a frame, which flickers while dragging. */
export function relayout() {
  for (const ed of [diffEditor, fileEd, histEd, mergeEds?.a, mergeEds?.b, mergeEds?.out]) if (ed?.getContainerDomNode().offsetParent) ed.layout();
}

/** The diff laid out and drawn in this frame, not the next: its changed lines' colours would stop at the old width for a frame. */
function drawNow() {
  relayout();
  diffEditor?.getOriginalEditor().render(true);
  diffEditor?.getModifiedEditor().render(true);
}
