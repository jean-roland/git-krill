// Monaco views: the diff with hunk and line staging, the merge tool, file history and blame.
import type * as Monaco from "monaco-editor/esm/vs/editor/edcore.main";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { applyChanges, allLines, pickLines, parseConflicts, mergeSides, pickedLines, parseBlame, toggleSide, toggleLine, hasSide, pickedOf } from "./core.js";
import { Blob, Change, Commit, active, fakeCommit, gitOp, headHash, lfsChip, opInfo, recordUndo, refresh, repo, run, status, tabs } from "./repo";
import { $, COLORS, ICONS, MenuItem, ask, avatar, avatarSvg, basename, colorIndex, copy, cssVar, dateText, dateTimeText, esc, h, hideBanner, input, megabytes, plural, popup, say, short, showBanner, store, svg, toast, whileLoading } from "./ui";
import { fileLists, isConflict, isSubmodule, markOpenFile, wipFiles } from "./panel";
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
    },
  });
  }));
type SubCommit = { hash: string; subject: string };
type SubmoduleChange = { old: SubCommit | null; new: SubCommit | null; added: SubCommit[]; removed: SubCommit[]; changed: number; untracked: number; initialized: boolean };
// full: loaded past the size a diff loads unasked; sub: what a submodule went through, shown instead of a text diff; ids: its sides' versions, see versionIds
export let diffFile: { kind: DiffSource; f: Change; c?: Commit; orig: Blob; mod: Blob; dirty: boolean; full: boolean; sub?: SubmoduleChange; ids?: string } | null = null;
export let diffEditor: Monaco.editor.IStandaloneDiffEditor | null = null;
// hunk header bars, as view zone ids per side
let hunkZones: { mod: string[]; orig: string[]; nodes: HTMLElement[] } = { mod: [], orig: [], nodes: [] };
let hunks: LineChange[] = [];
// the hunks' marks in the modified side's scrollbar
let changeMarks: Monaco.editor.IEditorDecorationsCollection;
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
    // its height lands ~200 ms late, once long lines are measured, and rescales the change markers; Shift+wheel still scrolls sideways
    scrollbar: { horizontal: "hidden" },
    // whitespace-only changes must show: they get staged too
    ignoreTrimWhitespace: false,
    originalEditable: false,
    renderMarginRevertIcon: false,
    renderGutterMenu: false,
    useInlineViewWhenSpaceIsLimited: false,
    // its two lanes and viewport box beside the minimap: one lane of marks in the scrollbar instead
    renderOverviewRuler: false,
    // halves, for a changed hunk's two colours
    overviewRulerLanes: 2,
    // the size cap is ours: past it a file loads only when asked
    maxFileSize: 0,
  });
  const me = diffEditor.getModifiedEditor();
  changeMarks = me.createDecorationsCollection();
  lineActions(me, false);
  lineActions(diffEditor.getOriginalEditor(), true);
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
  me.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save().then(refresh));
  applyMode();
  return diffEditor;
}

/** The line-level actions of one side: a +/− on the hovered changed line and the right-click menu. */
function lineActions(ed: Monaco.editor.ICodeEditor, orig: boolean) {
  const hover = ed.createDecorationsCollection();
  const staging = () => !!diffFile && diffFile.kind !== "commit";
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
      ...(diffFile?.kind === "staged" ? ([["Unstage selected lines", lines("unstage")]] as MenuItem[]) : []),
      ...(diffFile?.kind === "commit" && diffFile.c?.hash !== "WORKTREE" ? ([["Revert selected lines", () => revertLines(selectedLines(), "lines")]] as MenuItem[]) : []),
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
  // the diff editor forces its sub-editors' minimap off on every update; only Inline has room and use for one
  const minimap = { enabled: viewMode() === "inline", renderCharacters: false, showSlider: "always" as const };
  editor().getModifiedEditor().updateOptions({ minimap });
}

export function setMode(m: Mode) {
  store("diff-mode", m);
  applyMode();
}

/** The view shown: Monaco cannot fold a file loaded on request, so Inline stands in for Hunk there. */
const viewMode = (): Mode => {
  const m = (store("diff-mode") as Mode) || "hunk";
  return m === "hunk" && diffFile?.full ? "inline" : m;
};

function applyMode() {
  const m = viewMode(), full = !!diffFile?.full;
  setOptions({ renderSideBySide: m === "split", hideUnchangedRegions: { enabled: m === "hunk" } });
  updateHunkBars();
  document.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  // a diff's images: both in Split, else only the new one
  $("diff-binary").classList.toggle("single", m !== "split");
  const hunk = document.querySelector<HTMLElement>('[data-mode="hunk"]')!;
  // on top of paintSides' dimming, which clears it for a text diff
  if (full) hunk.classList.add("off");
  // Monaco cannot fold a file that big
  hunk.title = full ? "Can't show hunks for files over 10 MB" : "Changed hunks only";
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

/** A header bar above each hunk with its stage / unstage / discard / revert buttons. */
function updateHunkBars() {
  const ed = editor(), split = viewMode() === "split";
  const acts: [string, string][] =
    !diffFile ? []
    : diffFile.kind === "unstaged" ? [["discard", "Discard hunk"], ["stage", "Stage hunk"]]
    : diffFile.kind === "staged" ? [["unstage", "Unstage hunk"]]
    : diffFile.c?.hash !== "WORKTREE" ? [["revert", "Revert hunk"]]
    : [];
  hunks = diffFile ? lineChanges() : [];
  // a deletion marks the line it follows; a changed hunk splits the lane, removed left and added right
  const { Left, Right, Full } = monaco.editor.OverviewRulerLane;
  const colors: Record<string, string> = { "--add": `${cssVar("--add")}99`, "--del": `${cssVar("--del")}99` };
  const mark = (c: LineChange, color: string, position: Monaco.editor.OverviewRulerLane) => ({
    range: new monaco.Range(Math.max(c.ms, 1), 1, Math.max(c.me, c.ms, 1), 1),
    options: { overviewRuler: { color: colors[color], position } },
  });
  changeMarks.set(hunks.flatMap((c) => (!c.oe ? [mark(c, "--add", Full)] : !c.me ? [mark(c, "--del", Full)] : [mark(c, "--del", Left), mark(c, "--add", Right)])));
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
  ed.getModifiedEditor().changeViewZones((z) => {
    hunkZones.mod.forEach((id) => z.removeZone(id));
    hunkZones.nodes = shown.map((c) => bar(c, true));
    hunkZones.mod = shown.map((c, i) => z.addZone({ afterLineNumber: c.me ? c.ms - 1 : c.ms, heightInPx: 30, domNode: hunkZones.nodes[i] }));
  });
  // the original side gets the same bars in split view, so both sides stay aligned
  ed.getOriginalEditor().changeViewZones((z) => {
    hunkZones.orig.forEach((id) => z.removeZone(id));
    hunkZones.orig = split ? shown.map((c) => z.addZone({ afterLineNumber: c.oe ? c.os - 1 : c.os, heightInPx: 30, domNode: bar(c, false) })) : [];
  });
  fitHunkBars();
}

/** Hunk bars as wide as the visible text area, not the longest line, so the buttons stay in view. */
function fitHunkBars() {
  const lay = editor().getModifiedEditor().getLayoutInfo();
  editor().getContainerDomNode().querySelectorAll<HTMLElement>(".hunk-bar").forEach((b) => (b.style.width = `${lay.contentWidth - lay.verticalScrollbarWidth}px`));
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
  const [o, m] = sideSources(kind, f, c).map(([at, path]) => (at ? run<Blob>("blob", { at, path, full }) : Promise.resolve(none)));
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
  // what is on screen stays until the new diff is drawn: the graph under a see-through pane, a merge or diff under a still copy
  const gen = ++opening, fresh = $("diff").hidden && !merging;
  const copy = document.querySelector(".still") ?? still(merging ? $("merge") : [$("diff-editor"), $("diff-binary")].find((e) => !$("diff").hidden && !e.hidden));
  await closeMerge(true);
  diffFile = { kind, f, c, orig, mod, dirty: false, full: false, sub, ids };
  if (fresh) $("diff").classList.add("blank");
  $("diff").hidden = false;
  const range = c ? `  ·  ${c.parents[0] ? short(c.parents[0]) : "root"}..${short(c.hash)}` : "";
  $("diff-path").replaceChildren(...(orig.lfs || mod.lfs ? [lfsChip()] : []), (f.old ? `${f.old} → ${f.path}` : f.path) + range);
  paintOpenEditor();
  markOpenFile();
  // Monaco normalizes line endings, so a CRLF<->LF rewrite would not show at all
  const eol = (t: string) => (t.includes("\r\n") ? "CRLF" : t.includes("\n") ? "LF" : "");
  // a work file's CRLFs may be git's own checkout of LF text (autocrlf): not a change then
  if (eol(orig.text) && eol(mod.text) && eol(orig.text) !== eol(mod.text))
    ((kind === "unstaged" || c?.hash === "WORKTREE") && eol(mod.text) === "CRLF" ? run<boolean>("keeps_crlf", { path: f.path }) : Promise.resolve(true)).then(
      (kept) => kept && say(`${f.path}: line endings changed ${eol(orig.text)} → ${eol(mod.text)}, not shown in the diff`, true),
      () => {},
    );
  // a later file keeps the cover up until its own diff is drawn
  paintSides().then(() => requestAnimationFrame(() => gen === opening && (copy?.remove(), $("diff").classList.remove("blank"))));
}

let opening = 0;

/** A still copy of `el` laid over it, for the new view to draw unseen underneath. */
function still(el?: HTMLElement) {
  if (!el) return null;
  const copy = el.cloneNode(true) as HTMLElement;
  // canvases (minimap, overview ruler) do not clone their pixels
  const from = el.querySelectorAll("canvas");
  copy.querySelectorAll("canvas").forEach((c, i) => from[i].width && from[i].height && c.getContext("2d")?.drawImage(from[i], 0, 0));
  copy.classList.add("still");
  Object.assign(copy.style, { position: "absolute", zIndex: "20", pointerEvents: "none", left: `${el.offsetLeft}px`, top: `${el.offsetTop}px`, width: `${el.offsetWidth}px`, height: `${el.offsetHeight}px` });
  // after it: its ids still find the live element
  el.after(copy);
  return copy;
}

// lib.rs MAX_ASKED: past it a file does not load even when asked
const MAX_ASKED = 200 << 20;

/** The open diff's sides in the editor, or in their place a submodule's card, the images, or why not: binary, not downloaded, too big. */
function paintSides() {
  const { kind, f, c, orig, mod, sub } = diffFile!;
  const binary = orig.binary || mod.binary, large = Math.max(orig.large ?? 0, mod.large ?? 0);
  const missing = orig.lfs === "missing" || mod.lfs === "missing", isSvg = SVG.test(f.path) && !sub && !missing && !large;
  const images = (binary && !missing && (!large || large <= IMAGE_UNASKED) && IMAGE.test(f.path)) || (isSvg && store("svg-view") === "image");
  // the version a file opens in its app: the new one, the old when the file is gone
  const shown = sideSources(kind, f, c)[mod.exists ? 1 : 0];
  const pane = binary || !!large || !!sub || images;
  $("diff-editor").hidden = pane;
  $("diff-binary").hidden = !pane;
  $("diff-binary").classList.toggle("images", images);
  paintSvgView(isSvg, images);
  $("diff-binary").replaceChildren(
    ...(sub
      ? submoduleCard(f.path, sub)
      : missing
        ? [`${basename(f.path)} is stored with Git LFS and this version is not downloaded: whole-file actions only.`, lfsFetchButton()]
        : images
          ? [imageSides()]
          : binary && large && IMAGE.test(f.path)
            ? [`${basename(f.path)} is ${megabytes(large)}: too big to show unasked.`, forceLoadButton(large), openButton(...shown)]
            : binary
              ? [`Binary or non-UTF-8 file${large ? `, ${megabytes(large)}` : ""}: whole-file actions only.`, openButton(...shown)]
              : [`${basename(f.path)} is ${megabytes(large)}: too big to show, whole-file actions only.`, forceLoadButton(large), openButton(...shown)]),
  );
  $("diff-save").hidden = true;
  // no text diff: its view and change buttons have nothing to act on, but images still lay out by view
  dimDiffOpts(pane && !images);
  if (images) [$("prev-change"), $("next-change")].forEach((b) => b.classList.add("off"));
  applyMode();
  if (pane) return Promise.resolve(dropModels());
  // Monaco gives up on a diff after 5 s and marks the whole file changed: a file loaded on request gets the time it takes
  setOptions({ maxComputationTime: diffFile!.full ? 0 : 5000 });
  setModels(false);
  // the folds land a moment after the text
  return diffDrawn(diffFile!.full ? 300_000 : 500);
}

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
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i;
// text, also shown drawn when asked
const SVG = /\.svg$/i;
// raw bytes the window decodes itself, far cheaper than text in the editor: shown unasked up to this
const IMAGE_UNASKED = 50 << 20;
// past this an image is not drawn: decoded at 4 bytes a pixel, a 30000×30000 one would take the window's ~3.6 GB
const MAX_PIXELS = 100e6;

/** An SVG's diff as its text or as drawn, remembered for the next ones. */
export async function setSvgView(view: string) {
  // the text comes back from the file: edits to it would be lost
  if (!(await confirmDrop())) return;
  store("svg-view", view);
  if (diffFile) {
    diffFile.dirty = false;
    paintSides();
  }
  // the history's File view: showRev only redraws another row
  else if (hist) {
    const at = hist.at;
    hist.at = -1;
    showRev(at);
  }
}

/** The SVG switch: shown for an SVG, the half of its current view lit. */
function paintSvgView(shown: boolean, image: boolean) {
  $("svg-view").hidden = !shown;
  document.querySelectorAll<HTMLElement>("[data-svg]").forEach((b) => b.classList.toggle("on", (b.dataset.svg === "image") === image));
}
const sideName = (at: string) => (at === "WORKTREE" ? "Working tree" : at === "INDEX" ? "Staged" : at === "HEAD" ? "HEAD" : short(at));
const bytesText = (n: number) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : megabytes(n));

/** The open image's old and new versions, side by side. */
function imageSides() {
  const { kind, f, c, orig, mod } = diffFile!;
  const sides = sideSources(kind, f, c).flatMap(([at, path], i) => ((i ? mod : orig).exists ? [imageSide(at, path, i ? "add" : "del")] : []));
  return h("div", { className: "img-sides" }, ...sides);
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
    },
    (e) => (caption.textContent = String(e)),
  );
  return h("figure", { className: `img-side ${cls}` }, frame, caption);
}

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
    Object.assign(d, { orig, mod });
    paintSides();
  };
  return h("button", { className: "lfs-fetch", innerHTML: `${svg(ICONS.load)}Download from LFS`, onclick: fetchLfs });
}

/** Open version `at` of `path` in the desktop's app for its type. */
function openButton(at: string, path: string) {
  return h("button", { className: "open-default", innerHTML: `${svg(ICONS.external)}Open in default program`, onclick: () => (say(`Opening ${basename(path)}…`), run("open_version", { at, path }).catch((e) => say(String(e), true))) });
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

function setModels(keepView: boolean) {
  if (!diffFile) return;
  const ed = editor();
  const view = keepView ? ed.saveViewState() : null;
  const prev = diffView;
  const modified = newModel(diffFile.mod.text, `b/${diffFile.f.path}`);
  // Monaco 0.52 never disposes a view model it makes from bare models, nor the files it holds
  diffView = ed.createViewModel({ original: newModel(diffFile.orig.text, `a/${diffFile.f.path}`), modified });
  ed.setModel(diffView);
  prev?.dispose();
  prev?.model.original.dispose();
  prev?.model.modified.dispose();
  setOptions({ readOnly: !(diffFile.kind === "unstaged" && diffFile.mod.exists), glyphMargin: diffFile.kind !== "commit" });
  modified.onDidChangeContent(() => {
    if (!diffFile) return;
    diffFile.dirty = true;
    $("diff-save").hidden = false;
  });
  if (view) ed.restoreViewState(view);
}

/** The open WIP file's row in its list, for the file after it to take over if it leaves. */
export const openRow = () => (diffFile && diffFile.kind !== "commit" ? (fileLists.get($(diffFile.kind))?.order.findIndex((x) => x.path === diffFile!.f.path) ?? -1) : -1);

/** The open file left its list: the file now in its `row`, else the file's other side, else nothing. */
function moveOn(kind: "staged" | "unstaged", f: Change, row: number) {
  const order = fileLists.get($(kind))?.order ?? status![kind];
  const next = order[Math.min(Math.max(row, 0), order.length - 1)];
  const other = kind === "staged" ? "unstaged" : "staged", same = status![other].find((x) => x.path === f.path);
  return next ? openDiff(kind, next) : same ? openDiff(other, same) : closeDiff();
}

/** Refresh the open diff; `row` is where its WIP file was before the lists changed. */
export async function reloadDiff(row = -1) {
  const d = diffFile;
  if (!d || d.dirty || !status) return;
  const { kind, f } = d;
  if (kind !== "commit" && !status[kind].some((x) => x.path === f.path)) return moveOn(kind, f, row);
  // the file may have changed status code
  if (kind !== "commit") d.f = status[kind].find((x) => x.path === f.path)!;
  // a commit's sides never change, the uncommitted row of a file history aside
  else if (d.c?.hash !== "WORKTREE") return paintOpenEditor();
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
  d.ids = ids;
  paintOpenEditor();
  // an image has no text to compare: its new version is drawn
  const same = (a: Blob, b: Blob) => a.text === b.text && a.exists === b.exists && a.binary === b.binary && a.large === b.large && a.lfs === b.lfs && !a.binary;
  if (same(orig, d.orig) && same(mod, d.mod)) return;
  Object.assign(d, { orig, mod });
  // no text diff before or now: its pane is painted again
  if ($("diff-editor").hidden || orig.binary || mod.binary || orig.large || mod.large) return paintSides();
  // the old diff stays on screen until the new one is drawn
  const gen = opening, copy = still($("diff-editor"));
  setModels(true);
  await diffDrawn();
  // a file opened meanwhile took the copy over
  requestAnimationFrame(() => gen === opening && copy?.remove());
}

/** The text diff's models freed: a file loaded on request can be hundreds of MB. */
function dropModels() {
  if (!diffView) return;
  editor().setModel(null);
  diffView.dispose();
  diffView.model.original.dispose();
  diffView.model.modified.dispose();
  diffView = null;
}

export async function closeDiff(force = false) {
  if (!force && diffFile?.dirty && !(await ask(`Drop unsaved edits to ${diffFile.f.path}?`, "Drop edits"))) return;
  diffFile = null;
  $("diff").hidden = true;
  dropModels();
  markOpenFile();
}

export async function save() {
  if (!diffFile?.dirty) return;
  const text = editor().getModifiedEditor().getModel()!.getValue(monaco.editor.EndOfLinePreference.TextDefined, true);
  try {
    await run("write_file", { path: diffFile.f.path, text });
  } catch (e) {
    return say(String(e), true);
  }
  diffFile.mod.text = text;
  diffFile.dirty = false;
  $("diff-save").hidden = true;
  say(`saved ${diffFile.f.path}`);
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
  if (action === "discard") return discard(f.path, f.code === "?", whole ? undefined : keep());
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

export const confirmDiscard = (f: Change) => ask(`Discard all changes to ${f.path}?`, "Discard").then((ok) => (ok ? discard(f.path, f.code === "?") : undefined));

/** Discard `path` back to the index, or to `text` for some of its lines; undone by writing the old text back. */
export async function discard(path: string, untracked: boolean, text?: string) {
  const t = tabs[active], r = repo;
  const read = async () => {
    const b = await run<Blob>("blob", { at: "WORKTREE", path });
    return b.binary || b.large ? undefined : b.exists ? b.text : null;
  };
  const before = await read().catch(() => undefined);
  // the write is for the tab it was asked in
  if (repo !== r) return;
  if (text === undefined) await gitOp(untracked ? "clean" : "discard", path);
  else await run("write_file", { path, text }).then(() => say(`discarded lines of ${path}`), (e) => say(String(e), true));
  const after = await read().catch(() => undefined);
  await refresh();
  // a binary file has no text to put back
  if (before === undefined || after === undefined || before === after || repo !== r) return;
  const head = headHash(), branch = status?.branch ?? "";
  recordUndo(t, { op: "discard", what: basename(path), branch: [branch, branch], head: [head, head], file: [path, before, after] });
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
  fontSize: 13,
  scrollBeyondLastLine: false,
  stickyScroll: { enabled: false },
  contextmenu: false,
});

/** The merge tool's three editors, made on first use. */
function mergeEditors() {
  if (mergeEds) return mergeEds;
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
// the file's commits newest first, each with the file's name there, the one shown and its blame
export let hist: { path: string; revs: [Commit, Change][]; at: number; blame: Blamed[] } | null = null;
export let histEd: Monaco.editor.IStandaloneCodeEditor | null = null;
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
  await closeDiff();
  if (diffFile) return;
  // the working tree file as a commit on top of HEAD: blob and diff take WORKTREE as a revision
  if (wipFiles().some((f) => f.path === path))
    revs.unshift([fakeCommit("WORKTREE", ["HEAD"], "Uncommitted changes"), { path, old: null, code: "M" }]);
  if (!revs.length) return say(`${path} has no commits yet`);
  hist = { path, revs, at: -1, blame: [] };
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
    // back on the shown commit: a diff still loading for another gives way
    else openSeq++;
    if (hist !== m || m.at !== i) return;
    histPane(false);
    return reveal(opening ? diffDrawn() : undefined);
  }
  await closeDiff(true);
  histPane(true);
  $("diff-path").textContent = `${f.path} · ${short(c.hash)}`;
  // the file shows first, its blame (slower) fills the gutter when it comes
  const blame = run<string>("blame", { at: c.hash, path: f.path }).catch(() => "");
  const blob = await run<Blob>("blob", { at: c.hash, path: f.path }).catch((e) => (say(String(e), true), null));
  if (hist !== m || m.at !== i) return;
  if (!blob) return reveal();
  m.blame = [];
  // an image, or an SVG asked as one, shows as itself in the diff's binary pane
  const isSvg = SVG.test(f.path) && blob.exists && !blob.large, image = isSvg && store("svg-view") === "image";
  paintSvgView(isSvg, image);
  if (image || (IMAGE.test(f.path) && blob.binary && blob.lfs !== "missing" && (!blob.large || blob.large <= IMAGE_UNASKED))) {
    $("hist-file").hidden = true;
    $("diff-binary").hidden = false;
    $("diff-binary").classList.add("images");
    $("diff-binary").replaceChildren(h("div", { className: "img-sides" }, imageSide(c.hash, f.path)));
    return reveal();
  }
  const ed = historyEditor(), view = ed.saveViewState(), old = ed.getModel();
  const text = blob.lfs === "missing" ? "Stored with Git LFS, this version is not downloaded" : blob.binary ? "Binary or non-UTF-8 file" : blob.large ? `${megabytes(blob.large)}: too big to show here, the Diff view can load it` : blob.exists ? blob.text : `Deleted in ${short(c.hash)}`;
  ed.setModel(newModel(text, `h/${f.path}`));
  old?.dispose();
  // another version of the same file: stay around the same lines
  if (view) ed.restoreViewState(view);
  paintBlame();
  reveal();
  const blamed = parseBlame(await blame) as Blamed[];
  if (hist !== m || m.at !== i) return;
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
  $("diff-editor").hidden = $("diff-binary").hidden = $("svg-view").hidden = true;
  // the diff's own state undims them
  dimDiffOpts(true);
}

const dimDiffOpts = (dim: boolean) =>
  [$("prev-change"), $("next-change"), ...document.querySelectorAll<HTMLElement>("[data-mode]")].forEach((b) => b.classList.toggle("off", dim));

/** Show the history's pane once `drawn` settles, a frame later so it is painted. */
const reveal = (drawn?: Promise<unknown>) => (drawn ?? Promise.resolve()).then(() => requestAnimationFrame(() => $("hist-main").classList.remove("blank")));

// a diff's hunks and folds land a moment after its text
const diffDrawn = (ms = 500) =>
  new Promise((done) => {
    // the first update only drops the old diff: wait for one with changes computed, and the frame that draws its deleted lines
    const d = editor().onDidUpdateDiff(() => editor().getLineChanges() && (d.dispose(), requestAnimationFrame(done)));
    setTimeout(() => (d.dispose(), done(0)), ms);
  });

function historyEditor() {
  if (histEd) return histEd;
  histEd = monaco.editor.create($("hist-file"), { ...plainOpts(), readOnly: true, minimap: { renderCharacters: false, showSlider: "always" } });
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
  const m = hist!, on = store("hist-blame") === "on", digits = String(histEd!.getModel()!.getLineCount()).length;
  // ponytail: Monaco inserts the line number string as HTML, so the gutter is drawn as text; a view zone per line if it starts escaping
  histEd!.updateOptions({
    lineNumbersMinChars: (on ? BLAME_W + 1 : 0) + 4 + digits,
    lineNumbers: (n) => {
      const b = m.blame[n - 1], first = !!b && m.blame[n - 2]?.hash !== b.hash;
      const num = String(n).padStart(digits);
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

/** Lay the shown editors out now: Monaco's own resize handling waits a frame, which flickers while dragging. */
export function relayout() {
  for (const ed of [diffEditor, histEd, mergeEds?.a, mergeEds?.b, mergeEds?.out]) if (ed?.getContainerDomNode().offsetParent) ed.layout();
}
