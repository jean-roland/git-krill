// Pure logic, no DOM/Tauri: tested by test/core.test.js.
// A change is Monaco's ILineChange shortened to {os, oe, ms, me}: 1-based inclusive,
// an `oe`/`me` of 0 means that side is empty and `os`/`ms` is the line it follows.

/** Lines with their terminators, same breaks as Monaco (\r\n, \r, \n). */
export function splitLines(text) {
  return text.match(/[^\r\n]*(\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
}

/** Original text with only the `removed` original lines and `added` modified lines of `changes` applied. */
export function applyChanges(origText, modText, changes, removed, added) {
  const o = splitLines(origText), m = splitLines(modText), out = [];
  let next = 1;
  for (const c of changes) {
    for (const end = c.oe ? c.os - 1 : c.os; next <= end; next++) out.push(o[next - 1]);
    for (let l = c.os; c.oe && l <= c.oe; l++) if (!removed.has(l)) out.push(o[l - 1]);
    for (let l = c.ms; c.me && l <= c.me; l++) if (added.has(l)) out.push(m[l - 1]);
    next = c.oe ? c.oe + 1 : c.os + 1;
  }
  for (; next <= o.length; next++) out.push(o[next - 1]);
  // Monaco's empty last line has no entry in splitLines
  const lines = out.filter((l) => l !== undefined);
  const eol = (origText + modText).match(/\r\n|\r|\n/)?.[0] ?? "\n";
  return lines.map((l, i) => (i < lines.length - 1 && !/[\r\n]$/.test(l) ? l + eol : l)).join("");
}

/** Every removed and added line of `changes`. */
export function allLines(changes) {
  const removed = new Set(), added = new Set();
  for (const c of changes) {
    for (let l = c.os; c.oe && l <= c.oe; l++) removed.add(l);
    for (let l = c.ms; c.me && l <= c.me; l++) added.add(l);
  }
  return { removed, added };
}

/** Lines picked by selected line numbers `sel` on the `orig` or modified side. */
export function pickLines(changes, sel, orig) {
  const removed = new Set(), added = new Set();
  for (const c of changes) {
    if (orig) {
      for (let l = c.os; c.oe && l <= c.oe; l++) if (sel.has(l)) removed.add(l);
      continue;
    }
    let hit = !c.me && (sel.has(c.ms) || sel.has(c.ms + 1));
    for (let l = c.ms; c.me && l <= c.me; l++) if (sel.has(l)) (added.add(l), (hit = true));
    // removed lines are not selectable from the modified side: take them all
    for (let l = c.os; hit && c.oe && l <= c.oe; l++) removed.add(l);
  }
  return { removed, added };
}

/** A `git merge-file --diff3` result as chunks: common lines, and conflicts as {cur, base, inc} lines. */
export function parseConflicts(text) {
  const chunks = [];
  let common = [], c = null, part = "";
  for (const line of splitLines(text)) {
    const mark = line.slice(0, 7);
    if (!c && mark === "<<<<<<<") {
      if (common.length) chunks.push(common);
      common = [];
      c = { cur: [], base: [], inc: [] };
      part = "cur";
    } else if (c && mark === "|||||||" && part === "cur") part = "base";
    else if (c && mark === "=======" && part !== "inc") part = "inc";
    else if (c && mark === ">>>>>>>" && part === "inc") {
      chunks.push(c);
      c = null;
    } else if (c) c[part].push(line);
    else common.push(line);
  }
  if (c) chunks.push(c);
  if (common.length) chunks.push(common);
  return chunks;
}

/** Lines a conflict resolves to: its picked lines in click order, else its base. A pick is [side, line], line -1 taking an empty side. */
export const pickedLines = (c, pick) => (pick.length ? pick.flatMap(([s, i]) => (i < 0 ? [] : [(s === "a" ? c.cur : c.inc)[i]])) : c.base);

// a side's line indexes, -1 alone for an empty side
const sideLines = (c, side) => ((side === "a" ? c.cur : c.inc).length ? (side === "a" ? c.cur : c.inc).map((_, i) => i) : [-1]);
const picked = (pick, side, i) => pick.some(([s, j]) => s === side && j === i);

/** Whether every line of `side` is in `pick`. */
export const hasSide = (c, pick, side) => sideLines(c, side).every((i) => picked(pick, side, i));

/** `pick` with `side`'s missing lines appended, or without any of its lines when all were in. */
export const toggleSide = (c, pick, side) =>
  hasSide(c, pick, side) ? pick.filter(([s]) => s !== side) : [...pick, ...sideLines(c, side).filter((i) => !picked(pick, side, i)).map((i) => [side, i])];

/** `pick` with line `i` of `side` appended, or dropped when it was in. */
export const toggleLine = (pick, side, i) => (picked(pick, side, i) ? pick.filter(([s, j]) => s !== side || j !== i) : [...pick, [side, i]]);

/** The current (a) and incoming (b) texts, the output for `picks`, and each conflict's [first line, count] in all three. */
export function mergeSides(chunks, picks) {
  const a = [], b = [], out = [], regions = [];
  for (const c of chunks) {
    if (Array.isArray(c)) {
      a.push(...c), b.push(...c), out.push(...c);
      continue;
    }
    const lines = pickedLines(c, picks[regions.length] ?? []);
    regions.push({ a: [a.length + 1, c.cur.length], b: [b.length + 1, c.inc.length], out: [out.length + 1, lines.length] });
    a.push(...c.cur), b.push(...c.inc), out.push(...lines);
  }
  return { a: a.join(""), b: b.join(""), out: out.join(""), regions };
}

/** `git blame --porcelain` to each line's commit, in file order: {hash, author, time, summary}. */
export function parseBlame(text) {
  const seen = new Map(), lines = [];
  let c = null;
  // a commit's details follow only its first header line; content lines start with a tab
  for (const l of text.split("\n")) {
    const head = /^([0-9a-f]{40,64}) \d/.exec(l);
    if (head) {
      c = seen.get(head[1]) ?? { hash: head[1], author: "", time: 0, summary: "" };
      seen.set(c.hash, c);
    } else if (l.startsWith("\t")) lines.push(c);
    else if (l.startsWith("author ")) c.author = l.slice(7);
    else if (l.startsWith("author-time ")) c.time = Number(l.slice(12));
    else if (l.startsWith("summary ")) c.summary = l.slice(8);
  }
  return lines;
}

/** An author's pixel sprite: 7x7 cells mirrored left to right, with two eyes, and a hue (0-359), all from `seed`. */
export function sprite(seed) {
  // FNV-1a seeds mulberry32: a name always draws the same sprite
  let s = 2166136261;
  for (const ch of seed) s = Math.imul(s ^ ch.charCodeAt(0), 16777619);
  const rand = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const half = Array.from({ length: 7 }, () => Array.from({ length: 4 }, () => rand() < 0.5));
  // an eye is a hole ringed by body; empty corners keep the sprite inside its circle
  half[2][1] = false;
  for (const [r, c] of [[1, 1], [3, 1], [2, 0], [2, 2]]) half[r][c] = true;
  half[0][0] = half[6][0] = false;
  return { cells: half.map((row) => [...row, ...row.slice(0, 3).reverse()]), hue: Math.floor(rand() * 360) };
}

/** Lane of each commit and the lanes each parent edge travels through, `commits` in topo order. */
export function layoutGraph(commits) {
  const row = new Map(commits.map((c, i) => [c.hash, i]));
  const lanes = [], nodes = [], edges = [];
  commits.forEach((c, i) => {
    let lane = lanes.indexOf(c.hash);
    if (lane < 0) lane = lanes.indexOf(null) < 0 ? lanes.length : lanes.indexOf(null);
    for (let j = 0; j < lanes.length; j++) if (lanes[j] === c.hash) lanes[j] = null;
    lanes[lane] = null;
    nodes.push(lane);
    c.parents.forEach((p, k) => {
      // first parent keeps our lane, lanes holding the same parent converge at its row
      let via = k === 0 ? lane : lanes.indexOf(p);
      if (via < 0) via = lanes.indexOf(null) < 0 ? lanes.length : lanes.indexOf(null);
      lanes[via] = p;
      edges.push({ lane, row: i, via, to: p });
    });
  });
  for (const e of edges) {
    e.toRow = row.get(e.to) ?? commits.length;
    e.toLane = row.has(e.to) ? nodes[e.toRow] : e.via;
  }
  return { nodes, edges, width: Math.max(0, ...nodes, ...edges.map((e) => e.via)) + 1 };
}
