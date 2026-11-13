// DOM and store helpers, icons, avatars, menus, dialogs, toasts: no app state.
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { sprite } from "./core.js";

// null draws a separator
// an entry with items opens them beside it on hover
// a title heads the menu with what its items act on, so they need not name it
// a null action greys the entry out
export type MenuItem = [string, (() => unknown) | MenuItem[] | null] | { title: string; icon: string } | null;
export const COLORS = ["#46b1ab", "#5d88d9", "#9c5dd9", "#5bc78e", "#d9ba5d", "#d95d96", "#d97d5d", "#d95d72"];
export const ICONS: Record<string, string> = {
  m: "M4 20h4L19 9l-4-4L4 16z",
  a: "M12 5v14M5 12h14",
  d: "M5 12h14",
  r: "M5 12h14m-5-5 5 5-5 5",
  u: "M12 5v9m0 4v1",
  local: "M4 6h16v10H4zM2 19h20",
  remote: "M7 18a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 9a4.5 4.5 0 0 1 .5 9z",
  gone: "M7 18a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 9a4.5 4.5 0 0 1 .5 9zM3 3l18 18",
  tag: "M3 12V4h8l10 10-8 8zM7.5 8.5h.01",
  check: "M5 12l5 5L20 7",
  search: "M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zm5-2 5 5",
  commit: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v6M12 16v6",
  file: "M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5",
  branch: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9",
  stash: "M3 4h18v4H3zM5 8v12h14V8M10 12h4",
  worktree: "M8 19a4 4 0 0 1-2.24-7.32A3.5 3.5 0 0 1 9 6.03V6a3 3 0 1 1 6 0v.04a3.5 3.5 0 0 1 3.24 5.65A4 4 0 0 1 16 19zM12 19v3",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01",
  error: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM15 9l-6 6M9 9l6 6",
  folder: "M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z",
  folderGone: "M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5zM3 3l18 18",
  folderOpen: "M3 18.5v-12A1.5 1.5 0 0 1 4.5 5H9l2 2.5h7A1.5 1.5 0 0 1 19.5 9v1.5M3 18.5l2.6-7A1.5 1.5 0 0 1 7 10.5h14l-2.8 8.5a1.5 1.5 0 0 1-1.4 1H4.5A1.5 1.5 0 0 1 3 18.5z",
  globe: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z",
  home: "M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 22V12h6v10",
  repo: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z",
  close: "M6 6l12 12M18 6 6 18",
  up: "M12 19V5m-6 6 6-6 6 6",
  down: "M12 5v14m-6-6 6 6 6-6",
  caret: "m6 9 6 6 6-6",
  // in from the right, then down into the commit below
  into: "M20 6H9v13m-4-4 4 4 4-4",
  load: "M12 3v12m-5-5 5 5 5-5M5 21h14",
  skip: "M5 5l10 7-10 7zM19 5v14",
  save: "M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM7 3v5h8V3M7 21v-7h10v7",
  submodule: "M12 3l9 4.5-9 4.5-9-4.5zM3 12l9 4.5 9-4.5M3 16.5l9 4.5 9-4.5",
  sync: "M21 12a9 9 0 0 1-15.4 6.4L3 16M3 12a9 9 0 0 1 15.4-6.4L21 8M3 21v-5h5M21 3v5h-5",
  warn: "M12 3 2 21h20zM12 10v5M12 18h.01",
  eyeOff: "M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.1 4M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 5.4-1.6",
};
export const colorIndex = (s: string) => [...s].reduce((a, ch) => a + ch.charCodeAt(0), 0) % COLORS.length;
// each author's sprite is one <symbol> in #sprites, which every avatar of theirs uses: a light sprite on a dark disc of a neighbouring hue, the disc a cell wider all round
const spriteIds = new Map<string, string>();
export function spriteId(name: string) {
  let id = spriteIds.get(name);
  if (id) return id;
  spriteIds.set(name, (id = `av-${spriteIds.size}`));
  const { cells, hue } = sprite(name);
  const d = cells.flatMap((row, r) => row.map((on, c) => (on ? `M${c + 1} ${r + 1}h1v1h-1z` : ""))).join("");
  $("sprites").insertAdjacentHTML(
    "beforeend",
    `<symbol id="${id}" viewBox="-1 -1 11 11"><circle cx="4.5" cy="4.5" r="5.5" fill="hsl(${hue + 40},70%,24%)"/><path d="${d}" fill="hsl(${hue},75%,72%)"/></symbol>`,
  );
  return id;
}
export const avatarSvg = (name: string, cls = "") => `<svg class="${cls}" viewBox="0 0 9 9"><use href="#${spriteId(name)}"/></svg>`;
export const esc = (s: string) => s.replace(/[<>&"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
export const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });
export const dayFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "short" });

export const $ = (id: string) => document.getElementById(id)!;
export const input = (id: string) => $(id) as HTMLInputElement;
export const basename = (p: string) => p.split("/").pop() || p;
// names like WORKTREE stay whole
export const short = (hash: string) => (/^[0-9a-f]{8,}$/.test(hash) ? hash.slice(0, 7) : hash);

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...kids);
  return el;
}

// settings saved under their names before 2026-11-12 move to the new ones, once
const MOVED: Record<string, string> = { mode: "diff-mode", term: "term-open", active: "active-tab", pull: "pull-mode", blame: "hist-blame", "side-width": "sidebar-width", "panel-width": "details-width" };
const MOVED_PREFIX: Record<string, string> = { "hide:": "hidden-remotes:", "hide-refs:": "hidden-refs:", "side:": "sidebar-folds:" };
for (const key of Object.keys(localStorage)) {
  const prefix = Object.keys(MOVED_PREFIX).find((p) => key.startsWith(p));
  const now = MOVED[key] ?? (prefix && MOVED_PREFIX[prefix] + key.slice(prefix.length));
  if (!now) continue;
  if (localStorage.getItem(now) === null) localStorage.setItem(now, localStorage.getItem(key)!);
  localStorage.removeItem(key);
}

export function store(key: string, value?: string) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {}
  return value ?? null;
}

/** A design token of styles.css, like "--bg". */
export const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export const megabytes = (bytes: number) => `${(bytes / (1 << 20)).toFixed(bytes < 100 << 20 ? 1 : 0)} MB`;

/** Run `work` under a spinner that covers the window: nothing else can start meanwhile, for 30 s at most; `work` drops a late result. */
export async function whileLoading(label: string, work: (gaveUp: () => boolean) => Promise<unknown>) {
  $("loading-label").textContent = label;
  $("loading").hidden = false;
  // painted before the work starts: a big load holds the page up
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  let timer = 0, late = false;
  // a load that fails on the way never answers: the window must not wait for it forever
  const deadline = new Promise((done) => (timer = setTimeout(() => ((late = true), done(say(`${label} no answer after 30 s, gave up`, true))), 30_000)));
  try {
    await Promise.race([work(() => late), deadline]);
  } finally {
    clearTimeout(timer);
    $("loading").hidden = true;
  }
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Ctrl+Enter in any of `els` runs `fn`. */
export function onCtrlEnter(els: HTMLElement[], fn: () => unknown) {
  for (const el of els)
    el.onkeydown = (e) => {
      // a handler returning false cancels the key, so no expression body here
      if (e.ctrlKey && e.key === "Enter") fn();
    };
}

/** The bar over the graph that asks before an action, with `nodes` and a Cancel. */
export function showBanner(...nodes: Node[]) {
  $("banner").replaceChildren(...nodes, h("button", { textContent: "Cancel", onclick: hideBanner }));
  $("banner").hidden = false;
}
export const hideBanner = () => ($("banner").hidden = true);

export function say(msg: string, err = false) {
  // errors pop up, the status bar keeps the quiet news
  if (err) return toast("Error", msg + hint(msg), "err");
  const s = $("status");
  s.textContent = msg.replace(/\s*\n\s*/g, " · ");
  s.title = msg;
}

export const svg = (d: string) => `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;
/** Set a button's icon and text. */
export const label = (b: HTMLElement, d: string, text: string) => ((b.innerHTML = svg(d)), b.append(text));

/** A next step for the failures with a known cause. */
export function hint(msg: string) {
  if (/could not read Username|Authentication failed|terminal prompts disabled/.test(msg))
    return "\n\nThis https remote needs credentials krill can use: run `gh auth setup-git` once, or switch the remote to ssh.";
  return "";
}

/** A pop-up in the corner: errors stay until dismissed, info fades out. */
export function toast(title: string, body: string, kind: "err" | "info") {
  const dismiss = () => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 300);
  };
  const el = h(
    "div",
    { className: `toast ${kind}` },
    h("div", { className: "band", innerHTML: svg(kind === "err" ? ICONS.error : ICONS.info) }),
    h("div", { className: "t-body" }, h("b", { textContent: title }), h("pre", {}, ...linkify(body))),
    h("button", { className: "x", textContent: "×", title: "Dismiss", onclick: dismiss }),
  );
  $("toasts").append(el);
  // a short stack: the oldest goes
  while ($("toasts").children.length > 4) $("toasts").firstElementChild!.remove();
  if (kind === "info") setTimeout(dismiss, 10000);
}

/** Text with its web links clickable. */
function linkify(text: string) {
  return text
    .split(/(https?:\/\/[^\s'"<>]+)/)
    .map((part, i) => (i % 2 ? h("a", { textContent: part, onclick: () => invoke("open_url", { url: part }).catch((e) => say(String(e), true)) }) : part));
}

export async function pickDir(title: string) {
  const p = await openDialog({ directory: true, title });
  return typeof p === "string" ? p : null;
}

// what closing the open dialog without its action means, if anything
let dialogCancel: (() => unknown) | null = null;
// dialogs a newer one covers, like a clone under its passphrase prompt: back on top when it goes
const dialogsUnder: { nodes: Element[]; cancel: (() => unknown) | null }[] = [];

/** Show a dialog, over any open one: `title` with a ×, `body`, then Cancel and the `actions`. */
export function showDialog(title: string, body: Node[], actions: Node[], cancel: (() => unknown) | null, cls = "") {
  if (!$("dialog").hidden) dialogsUnder.push({ nodes: [...$("dialog").children], cancel: dialogCancel });
  dialogCancel = cancel;
  $("dialog").replaceChildren(
    h(
      "div",
      { className: `dlg ${cls}`.trim() },
      h("div", { className: "dlg-head" }, h("b", { textContent: title }), h("button", { className: "x", textContent: "×", title: "Close (Esc)", onclick: closeDialog })),
      ...body,
      h("div", { className: "dlg-actions" }, h("button", { textContent: "Cancel", onclick: closeDialog }), ...actions),
    ),
  );
  $("dialog").hidden = false;
}

/** Take the top dialog away, without its cancel. */
export function hideDialog() {
  const under = dialogsUnder.pop();
  dialogCancel = under?.cancel ?? null;
  if (under) $("dialog").replaceChildren(...under.nodes);
  else $("dialog").hidden = true;
}

/** Cancel the top dialog: its Cancel, its ×, Esc and a click beside it all end here. */
export function closeDialog() {
  const cancel = dialogCancel;
  hideDialog();
  cancel?.();
}

/** A dialog of `fields` ([label, value, input type]); a password is kept as typed, the rest trimmed. */
export function dialog(
  title: string,
  fields: [string, string, string?][],
  action: string,
  save: (values: string[]) => unknown,
  more: [string, () => unknown][] = [],
  cancel?: () => unknown,
) {
  const inputs = fields.map(([, value, type = "text"]) => h("input", { value, type, spellcheck: false }));
  const submit = () => {
    hideDialog();
    save(inputs.map((i) => (i.type === "password" ? i.value : i.value.trim())));
  };
  for (const i of inputs) {
    i.onkeydown = (e) => {
      if (e.key === "Enter") submit();
    };
  }
  showDialog(
    title,
    fields.flatMap(([label], k) => [h("label", { textContent: label }), inputs[k]]),
    [...more.map(([label, fn]) => h("button", { textContent: label, onclick: () => (hideDialog(), fn()) })), h("button", { className: "primary", textContent: action, onclick: submit })],
    cancel ?? null,
  );
  (inputs[0] ?? $("dialog").querySelector("button.primary")).focus();
}

// WebKitGTK's confirm() returns true without showing anything
export const ask = (question: string, action: string) => new Promise<boolean>((done) => dialog(question, [], action, () => done(true), [], () => done(false)));

export const ico = (d: string, title = "") => h("span", { className: "ico", title, innerHTML: svg(d) });

export function popup(e: MouseEvent, items: MenuItem[]) {
  e.preventDefault();
  if (items.some(Boolean)) showMenu(items, e.clientX, e.clientY);
}

export function showMenu(items: MenuItem[], x: number, y: number) {
  const m = $("menu");
  fillMenu(m, items);
  $("submenu").hidden = true;
  m.hidden = false;
  m.style.left = `${Math.min(x, innerWidth - m.offsetWidth - 4)}px`;
  m.style.top = `${Math.max(4, Math.min(y, innerHeight - m.offsetHeight - 4))}px`;
}

/** The rows of a menu; an entry with items shows them beside it on hover. */
function fillMenu(m: HTMLElement, items: MenuItem[]) {
  // separators only between two groups of actions: none under the title
  const kept = items.filter((it, i) => it || (items.slice(0, i).some(Array.isArray) && items.slice(i + 1).some(Array.isArray)));
  const rows = kept.filter((it, i) => it || kept[i - 1]);
  const sub = $("submenu");
  m.replaceChildren(
    ...rows.map((it) => {
      if (!it) return h("hr");
      if (!Array.isArray(it)) return h("div", { className: "menu-title", title: it.title }, ico(it.icon), h("span", { textContent: it.title }));
      const [label, act] = it;
      // a very long name (a branch, a remote) is cut in its middle: the action around it stays readable
      const b = h("button", { textContent: label.replace(/\S{33,}/g, (w) => `${w.slice(0, 16)}…${w.slice(-12)}`), disabled: !act });
      if (!act) return b;
      if (typeof act === "function") {
        b.onclick = act;
        // leaving for another row of the main menu closes the side one
        if (m !== sub) b.onmouseenter = () => void (sub.hidden = true);
        return b;
      }
      b.className = "sub";
      // a click keeps the menu open: the items are what matters
      b.onclick = (e) => e.stopPropagation();
      b.onmouseenter = () => {
        fillMenu(sub, act);
        sub.hidden = false;
        const r = b.getBoundingClientRect();
        sub.style.left = `${r.right + sub.offsetWidth + 4 > innerWidth ? r.left - sub.offsetWidth - 2 : r.right + 2}px`;
        sub.style.top = `${Math.max(4, Math.min(r.top - 6, innerHeight - sub.offsetHeight - 4))}px`;
      };
      return b;
    }),
  );
}

/** A one-field prompt where the menu was; Enter hands the trimmed text to `done`. */
export function askName(label: string, initial: string, done: (name: string) => unknown) {
  setTimeout(() => {
    const box = h("input", { className: "ask", value: initial, placeholder: label, spellcheck: false, onclick: (e: Event) => e.stopPropagation() });
    box.onkeydown = (e) => {
      if (e.key === "Enter" && box.value.trim()) {
        $("menu").hidden = true;
        done(box.value.trim());
      }
    };
    const m = $("menu");
    m.replaceChildren(h("small", { textContent: label }), box);
    m.hidden = false;
    box.select();
  });
}

/** A short hash that copies the full one on click. */
export const shaLink = (hash: string) => h("span", { className: "sha", textContent: short(hash), title: `Copy ${hash}`, onclick: () => copy(hash) });

// keys wait with the rest of the window while a big file loads
addEventListener("keydown", (e) => !$("loading").hidden && (e.preventDefault(), e.stopImmediatePropagation()), true);
// the page's icons drawn from ICONS: <svg data-icon="close">
document.querySelectorAll<SVGElement>("svg[data-icon]").forEach((s) => {
  s.setAttribute("viewBox", "0 0 24 24");
  s.innerHTML = `<path d="${ICONS[s.dataset.icon!]}"/>`;
});
// where the last click landed: "Copied!" pops up there
let clickAt = [0, 0];
addEventListener("pointerdown", (e) => (clickAt = [e.clientX, e.clientY]), true);
// a greyed-out button (a class, not `disabled`: WebKit shows no tooltip on a disabled one) says why instead of acting
addEventListener(
  "click",
  (e) => {
    const off = (e.target as Element).closest?.<HTMLElement>(".off");
    if (off) (e.stopImmediatePropagation(), say(off.title || off.dataset.tip || ""));
  },
  true,
);

export async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    say(`copied ${text.length > 60 ? `${text.slice(0, 60)}…` : text}`);
    const tip = h("div", { className: "copied", textContent: "Copied!" });
    Object.assign(tip.style, { left: `${clickAt[0]}px`, top: `${clickAt[1] - 30}px` });
    document.body.append(tip);
    setTimeout(() => tip.remove(), 1200);
  } catch (e) {
    say(String(e), true);
  }
}

export const avatar = (name: string) => h("span", { className: "avatar", title: name, innerHTML: avatarSvg(name) });
