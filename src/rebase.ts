import { Commit, commits, gitOp, headHash, isHead, opInfo, repo, selection } from "./repo";
import { paintSelection } from "./graph";
import { $, ICONS, MenuItem, avatar, h, ico, mod, popup, say, short, showDialog, showMenu, hideDialog, onCtrlEnter, svg } from "./ui";
import { countLeft, joinMsg, renderPanel, splitMsg } from "./panel";

type Action = "pick" | "reword" | "squash" | "drop";
// one commit of the plan; message is the reworded one, empty while unchanged
// fixup: a squash whose message is dropped
type Row = { c: Commit; action: Action; message: string; fixup?: boolean };

const ACTIONS: [Action, string, string][] = [
  ["pick", "Pick", ICONS.check],
  ["reword", "Reword", ICONS.m],
  ["squash", "Squash", ICONS.squash],
  ["drop", "Drop", ICONS.trash],
];
// the plan on screen: the commits replayed onto `base`, newest first, the picked row `at`, made in `repo` with HEAD at `head`
// picked: the rows an action goes to, by hash: a Ctrl or Shift click picks several, a drag keeps them
let plan: { base: string; rows: Row[]; at: number; repo: string; head: string; picked: Set<string> } | null = null;

const message = (c: Commit) => joinMsg(c.subject, c.body);

/** The commits after `base` on HEAD's first-parent line, newest first; null when a merge is among them or base is off that line. */
export function rebaseRange(base: Commit) {
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const rows: Commit[] = [];
  for (let c = commits.find(isHead); c && c.hash !== base.hash; c = byHash.get(c.parents[0])) {
    if (c.parents.length > 1) return null;
    rows.push(c);
  }
  return rows.length && rows[rows.length - 1].parents[0] === base.hash ? rows : null;
}

/** HEAD's own commits, those `target` lacks, newest first: what rebasing onto it replays; null when a merge is among them, undefined when they go past the loaded ones. */
export function ontoRange(target: string) {
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  if (!byHash.has(target)) return undefined;
  const theirs = new Set<string>(), todo = [target];
  while (todo.length) {
    const at = todo.pop()!;
    if (theirs.has(at) || !byHash.has(at)) continue;
    theirs.add(at);
    todo.push(...byHash.get(at)!.parents);
  }
  const rows: Commit[] = [];
  for (let c = commits.find(isHead); c && !theirs.has(c.hash); c = byHash.get(c.parents[0])) {
    if (c.parents.length > 1) return null;
    rows.push(c);
  }
  // the walk ran off the loaded commits before meeting the target's
  const last = rows[rows.length - 1];
  return last?.parents.length && !theirs.has(last.parents[0]) ? undefined : rows;
}

/** Open the plan replaying `range` onto commit `base`. */
export function openRebase(base: string, range: Commit[] | null | undefined) {
  if (opInfo) return say("Interactive rebase: finish or abort the operation in progress first", true);
  if (range === undefined) return say("Interactive rebase: the commits to replay go past the loaded ones, load more commits first", true);
  if (!range) return say("Interactive rebase: the commits to replay include a merge", true);
  if (!range.length) return say("Interactive rebase: nothing to replay, the branch has no commit this one lacks", true);
  plan = { base, rows: range.map((c) => ({ c, action: "pick", message: "" })), at: 0, repo, head: headHash(), picked: new Set() };
  $("rebase").hidden = false;
  pick(0);
}

export const planOpen = () => !!plan;

export function closeRebase() {
  if (!plan) return;
  plan = null;
  $("rebase").hidden = true;
  // the graph's selection follows the row the plan showed
  selection.anchor = selection.hashes[0];
  paintSelection();
  // the panel's message editing comes back
  renderPanel();
}

/** The pick or reword row a squash at `i` folds into: the next older one, past drops and other squashes. */
function target(i: number) {
  const rows = plan!.rows;
  for (let k = i + 1; k < rows.length; k++) if (rows[k].action === "pick" || rows[k].action === "reword") return k;
  return -1;
}

/** The message row `i` ends with: its own or reworded one, then those squashed into it. */
function finalMessage(i: number) {
  const rows = plan!.rows, own = rows[i].message || message(rows[i].c);
  // oldest first, as git folds them
  const squashed = [...rows.keys()].reverse().flatMap((k) => (rows[k].action === "squash" && !rows[k].fixup && target(k) === i ? [message(rows[k].c)] : []));
  return rows[i].message ? own : [own, ...squashed].join("\n\n");
}

function paint() {
  // a reword dialog can outlive the plan
  if (!plan) return;
  const p = plan;
  $("rebase-what").replaceChildren(`Rebasing ${p.rows.length} commits onto `, h("code", { textContent: short(p.base) }));
  $("rebase-rows").replaceChildren(
    ...p.rows.map((r, i) => {
      const into = r.action === "squash" ? target(i) : -1, [, label, icon] = ACTIONS.find(([a]) => a === r.action)!;
      // krill's own menu, not the system's list: it matches the rest
      const act = h(
        "button",
        {
          className: "rb-act",
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            const at = act.getBoundingClientRect();
            showMenu(actionMenu(i), at.left, at.bottom + 2, act);
          },
        },
        ico(icon),
        h("span", { textContent: label }),
        ico(ICONS.caret),
      );
      const subject = r.action === "pick" || r.action === "reword" ? splitMsg(finalMessage(i))[0] : r.c.subject;
      return h(
        "div",
        {
          className: `rb-row ${r.action}${p.picked.has(r.c.hash) ? " sel" : ""}`,
          onclick: (e: MouseEvent) => click(e, i),
          ondblclick: () => setAction(i, "reword"),
          onpointerdown: (e: PointerEvent) => drag(e, i),
          // a row out of the pick becomes the pick, as in a file manager
          oncontextmenu: (e: MouseEvent) => (p.picked.has(r.c.hash) || pick(i), popup(e, actionMenu(i))),
        },
        act,
        ...(r.action === "squash" ? [h("span", { className: "rb-into", innerHTML: svg(ICONS.into) })] : []),
        avatar(r.c.author),
        h("span", { className: "rb-subject", textContent: subject }),
        ...(into >= 0 ? [h("small", { textContent: `into ${short(p.rows[into].c.hash)}` }), keepBox(r, p.rows[into])] : []),
      );
    }),
  );
}

/** A squash's message goes into `into`'s, unless unticked; a reworded one is used as written. */
function keepBox(r: Row, into: Row) {
  const sha = short(into.c.hash), fixed = into.action === "reword";
  const box = h("input", { type: "checkbox", checked: !r.fixup && !fixed, disabled: fixed, onchange: () => ((r.fixup = !box.checked), paint()) });
  const title = fixed ? `${sha} is reworded: its new message is used as written` : `${r.fixup ? `Its message is dropped: ${sha} keeps its own` : `Its message is added to ${sha}'s`} — shortcut: M`;
  return h("label", { className: "rb-keep", title, onclick: (e: Event) => e.stopPropagation(), ondblclick: (e: Event) => e.stopPropagation() }, box, " message");
}

/** M: the picked squashes keep or drop their messages, all alike. */
function toggleMessages() {
  const rows = plan!.rows, squashes = pickedRows().filter((k) => rows[k].action === "squash" && rows[target(k)]?.action !== "reword");
  const fixup = !squashes.every((k) => rows[k].fixup);
  squashes.forEach((k) => (rows[k].fixup = fixup));
  paint();
}

/** Ctrl+click adds a row to the picked ones, Shift+click picks a run from the last one; a click picks one. */
function click(e: MouseEvent, i: number) {
  const p = plan!, hash = p.rows[i].c.hash;
  if (e.shiftKey) {
    const [a, b] = [p.at, i].sort((x, y) => x - y);
    p.picked = new Set(p.rows.slice(a, b + 1).map((r) => r.c.hash));
  } else if (mod(e) && !p.picked.delete(hash)) p.picked.add(hash);
  // never none: the keys would act on nothing
  if (!p.picked.size) p.picked.add(hash);
  // the run's start stays put
  if (e.shiftKey) return paint();
  pick(i, mod(e));
}

/** The actions for row `i`, or for every picked row when it is one of them. */
function actionMenu(i: number): MenuItem[] {
  const many = plan!.picked.has(plan!.rows[i].c.hash) ? pickedRows() : [i];
  const n = many.length > 1 ? ` ${many.length} commits` : "";
  // the oldest commit has nothing older to fold into; a new message is one commit's
  const why = (a: Action) => (a === "squash" && !n && target(i) < 0 ? "No older commit to squash into" : a === "reword" && n ? "Reword one commit at a time" : "");
  return ACTIONS.map(([a, label, icon]) => [label + n, why(a) ? null : () => setActions(many, a), why(a), icon]);
}

/** The picked rows' indexes, newest first. */
const pickedRows = () => plan!.rows.flatMap((r, i) => (plan!.picked.has(r.c.hash) ? [i] : []));

/** Show row `i`'s commit in the right panel; it becomes the one picked row, unless `keep`. */
function pick(i: number, keep = false) {
  plan!.at = Math.max(0, Math.min(i, plan!.rows.length - 1));
  if (!keep) plan!.picked = new Set([plan!.rows[plan!.at].c.hash]);
  selection.stash = null;
  selection.hashes = [plan!.rows[plan!.at].c.hash];
  renderPanel();
  paint();
  $("rebase-rows").children[plan!.at]?.scrollIntoView({ block: "nearest" });
}

/** Set `action` on rows `idx` at once; one row goes through setAction, for its checks and reword's message. */
function setActions(idx: number[], action: Action) {
  if (idx.length === 1) return setAction(idx[0], action);
  for (const i of idx) Object.assign(plan!.rows[i], { action, message: "", fixup: false });
  // the oldest of several squashes, with nothing older, is picked: the others fold into it
  unsquashOrphans();
  paint();
}

function setAction(i: number, action: Action) {
  const r = plan!.rows[i];
  if (action === "squash" && target(i) < 0) return paint();
  // any other action drops the new message: back to the commit's own
  if (action !== "reword") {
    Object.assign(r, { action, message: "", fixup: false });
    unsquashOrphans();
    return paint();
  }
  // reword asks the new message first; cancelling keeps the old action
  const [s, d] = splitMsg(r.action === "reword" && r.message ? r.message : finalMessage(i));
  const summary = h("input", { className: "msg-in", value: s, spellcheck: false });
  const desc = h("textarea", { className: "msg-in", value: d, spellcheck: false, placeholder: "Description" });
  const left = h("small");
  const update = () => {
    const m = joinMsg(summary.value, desc.value);
    if (!m) return say("empty commit message", true);
    hideDialog();
    if (!plan) return;
    Object.assign(r, { action: "reword", message: m });
    paint();
  };
  summary.oninput = () => countLeft(summary, left);
  countLeft(summary, left);
  onCtrlEnter([desc], update);
  // a popup: Enter in its one-line field validates, like every other
  summary.onkeydown = (e) => {
    if (e.key === "Enter") update();
  };
  showDialog(`Reword ${short(r.c.hash)}`, [h("div", { className: "summary" }, summary, left), desc], [h("button", { className: "primary", textContent: "Update message", onclick: update })], paint, "reword");
  summary.focus();
}

/** A squash left with nothing older to fold into is picked, oldest first: a newer one may then fold into it. */
function unsquashOrphans() {
  const rows = plan!.rows;
  for (let k = rows.length - 1; k >= 0; k--) if (rows[k].action === "squash" && target(k) < 0) rows[k].action = "pick";
}

function move(i: number, by: number) {
  const rows = plan!.rows, j = i + by;
  if (j < 0 || j >= rows.length) return;
  [rows[i], rows[j]] = [rows[j], rows[i]];
  unsquashOrphans();
  pick(j, plan!.picked.has(rows[j].c.hash));
}

/** Drag row `i` up or down: the rows reorder live under the pointer, like the tabs. */
function drag(e: PointerEvent, i: number) {
  if (e.button !== 0 || (e.target as HTMLElement).closest(".rb-act, .rb-keep")) return;
  const y0 = e.clientY;
  let at = i, moved = false;
  const follow = (m: PointerEvent) => {
    // released outside the window: no pointerup came
    if (!m.buttons) return up();
    if (!plan || (!moved && Math.abs(m.clientY - y0) < 5)) return;
    moved = true;
    const els = [...$("rebase-rows").children] as HTMLElement[];
    const to = els.filter((el, k) => k !== at && (({ top, height }) => top + height / 2 < m.clientY)(el.getBoundingClientRect())).length;
    if (to !== at) {
      plan.rows.splice(to, 0, ...plan.rows.splice(at, 1));
      plan.at = at = to;
      paint();
    }
    $("rebase-rows").children[at].classList.add("drag");
  };
  const up = () => {
    removeEventListener("pointermove", follow);
    if (!moved || !plan) return;
    unsquashOrphans();
    pick(at, plan.picked.has(plan.rows[at].c.hash));
  };
  addEventListener("pointermove", follow);
  addEventListener("pointerup", up, { once: true });
}

/** Run the plan: git's own steps, oldest first, with a new message after the last commit of each rewritten one. */
async function start() {
  const p = plan!, rows = p.rows;
  // a pull, an undo or a tab switch since: the plan no longer says what the branch holds
  if (repo !== p.repo || headHash() !== p.head) {
    closeRebase();
    return say("Interactive rebase: the branch moved since the plan was made, open it again", true);
  }
  // by hash: a refresh brings new commit objects
  const at = new Map(commits.map((c, k) => [c.hash, k])), index = (r: Row) => at.get(r.c.hash) ?? -1;
  const steps: string[][] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    steps.push([r.action === "drop" ? "drop" : r.action === "squash" ? "fixup" : "pick", r.c.hash]);
    // the last squash into a commit, or the commit itself when none follows, carries its message
    const t = r.action === "squash" ? target(i) : r.action === "drop" ? -1 : i;
    const lastOfGroup = t >= 0 && !rows.slice(0, i).some((o, k) => o.action === "squash" && target(k) === t);
    const rewritten = t >= 0 && (rows[t].action === "reword" || rows.some((o, k) => o.action === "squash" && !o.fixup && target(k) === t));
    if (lastOfGroup && rewritten) steps[steps.length - 1].push(finalMessage(t));
  }
  // commits newest first, as the graph has them, when nothing moved
  const inPlace = rows.every((r, i) => !i || index(rows[i - 1]) < index(r));
  // an untouched plan onto another base is still a plain rebase
  const onBase = rows[rows.length - 1].c.parents[0] === p.base;
  closeRebase();
  if (inPlace && onBase && rows.every((r) => r.action === "pick")) return;
  await gitOp("rebase-interactive", [p.base, JSON.stringify(steps)]);
}

$("rebase-cancel").onclick = $("rebase-close").onclick = closeRebase;
// a click past the rows ends a pick of several: the row shown stays picked
$("rebase-rows").onclick = $("rebase-rows").oncontextmenu = (e) => void (e.target === e.currentTarget && plan && pick(plan.at));
$("rebase-reset").onclick = () => {
  if (!plan) return;
  const at = new Map(commits.map((c, k) => [c.hash, k]));
  plan.rows = plan.rows.sort((a, b) => at.get(a.c.hash)! - at.get(b.c.hash)!).map((r) => ({ ...r, action: "pick", message: "", fixup: false }));
  paint();
  pick(0);
};
$("rebase-start").onclick = () => plan && start();

/** The plan's keys while it is open: p r s d set the action, arrows pick a row, Ctrl+arrows move it. */
export function rebaseKey(e: KeyboardEvent) {
  // the merge tool over the plan has the keys
  if (!plan || $("rebase").hidden || !$("merge").hidden) return false;
  const i = plan.at, key = e.key.toLowerCase();
  if (e.key === "Escape") closeRebase();
  else if (mod(e) && (e.key === "ArrowUp" || e.key === "ArrowDown")) move(i, e.key === "ArrowUp" ? -1 : 1);
  else if (e.key === "ArrowUp" || e.key === "ArrowDown") pick(i + (e.key === "ArrowUp" ? -1 : 1));
  // reword is one commit's: the row shown
  else if (!mod(e) && !e.altKey && "prsd".includes(key) && key) setActions(key === "r" ? [i] : pickedRows(), ACTIONS.find(([a]) => a[0] === key)![0]);
  else if (!mod(e) && !e.altKey && key === "m") toggleMessages();
  else return false;
  return true;
}
