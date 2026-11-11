// The bottom panel: one shell per tab, in its repository.
import { invoke, Channel } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Tab, active, refresh, repo, tabs } from "./repo";
import { $, cssVar, h, say, store } from "./ui";
import { relayout } from "./diff";

type Term = { term: Terminal; fit: FitAddon; el: HTMLElement; id: number; armed: boolean };
export const terms = new Map<Tab, Term>();
let termIdle = 0;

const termTheme = () => ({
  background: cssVar("--bg"),
  foreground: cssVar("--text"),
  cursor: cssVar("--accent"),
  selectionBackground: `${cssVar("--accent")}66`,
  black: cssVar("--raised"),
  red: cssVar("--del"),
  green: cssVar("--add"),
  yellow: cssVar("--mod"),
  blue: "#4f8cff",
  magenta: cssVar("--ren"),
  cyan: "#26d4ca",
  white: cssVar("--text"),
  brightBlack: "#5d6575",
});

/** The tab's shell, started on first use in its repo. */
function termFor(tab: Tab) {
  const known = terms.get(tab);
  if (known) return known;
  const el = h("div", { className: "term" });
  $("term").append(el);
  const term = new Terminal({ fontFamily: cssVar("--mono"), fontSize: 13, theme: termTheme(), cursorBlink: true });
  const t: Term = { term, fit: new FitAddon(), el, id: 0, armed: false };
  terms.set(tab, t);
  term.loadAddon(t.fit);
  term.open(el);
  t.fit.fit();
  // a command typed here may change the repo: refresh once its output settles
  const settle = () => {
    clearTimeout(termIdle);
    termIdle = setTimeout(() => {
      t.armed = false;
      if (tab === tabs[active]) refresh();
    }, 400);
  };
  const out = new Channel<ArrayBuffer>();
  out.onmessage = (b) => {
    if (!b.byteLength) return (dropTerm(tab), tab === tabs[active] && toggleTerm(false));
    term.write(new Uint8Array(b));
    if (t.armed) settle();
  };
  invoke<number>("pty_spawn", { repo: tab.repo, cols: term.cols, rows: term.rows, onData: out })
    .then((id) => (terms.get(tab) === t ? (t.id = id) : invoke("pty_kill", { id })))
    .catch((e) => say(String(e), true));
  term.onData((data) => {
    if (!t.id) return;
    invoke("pty_write", { id: t.id, data });
    if (data.includes("\r")) (t.armed = true), settle();
  });
  term.onResize(({ cols, rows }) => t.id && invoke("pty_resize", { id: t.id, cols, rows }));
  term.attachCustomKeyEventHandler((e) => !(e.ctrlKey && (e.code === "Backquote" || e.key === "Tab")));
  return t;
}

export function dropTerm(tab: Tab) {
  const t = terms.get(tab);
  if (!t) return;
  terms.delete(tab);
  if (t.id) invoke("pty_kill", { id: t.id });
  t.term.dispose();
  t.el.remove();
}

/** Show the bottom panel with the active tab's shell when the panel is open. */
export function showTerm(focus: boolean) {
  const open = !!store("term") && !!repo;
  $("term").hidden = !open;
  // the editors above get the new height in this frame, not the next
  relayout();
  $("term-btn").classList.toggle("on", open);
  terms.forEach((t, tab) => (t.el.hidden = tab !== tabs[active]));
  if (!open) return;
  // paint the panel first: xterm's setup and the shell spawn take a moment
  requestAnimationFrame(() =>
    setTimeout(() => {
      if ($("term").hidden || !repo) return;
      const t = termFor(tabs[active]);
      t.el.hidden = false;
      t.fit.fit();
      if (focus) t.term.focus();
    }),
  );
}

export function toggleTerm(open = $("term").hidden) {
  store("term", open ? "1" : "");
  showTerm(open);
}
