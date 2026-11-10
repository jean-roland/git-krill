import test from "node:test";
import assert from "node:assert/strict";
import { splitLines, applyChanges, allLines, pickLines, layoutGraph, parseConflicts, mergeSides, parseBlame, sprite } from "../src/core.js";

test("splitLines keeps terminators", () => {
  assert.deepEqual(splitLines("a\r\nb\nc"), ["a\r\n", "b\n", "c"]);
  assert.deepEqual(splitLines(""), []);
});

test("applyChanges stages a subset", () => {
  const o = "a\nb\nc\n", m = "a\nB\nc\nd\n";
  const ch = [{ os: 2, oe: 2, ms: 2, me: 2 }, { os: 3, oe: 0, ms: 4, me: 4 }];
  assert.equal(applyChanges(o, m, ch, new Set([2]), new Set([2])), "a\nB\nc\n");
  assert.equal(applyChanges(o, m, ch, new Set(), new Set([4])), "a\nb\nc\nd\n");
  const all = allLines(ch);
  assert.equal(applyChanges(o, m, ch, all.removed, all.added), m);
  // only the + line of a modification: the - line stays as context
  assert.equal(applyChanges(o, m, ch, new Set(), new Set([2])), "a\nb\nB\nc\n");
});

test("applyChanges keeps CRLF and fixes a missing final newline", () => {
  assert.equal(applyChanges("a\r\nb\r\n", "a\r\nX\r\nb\r\n", [{ os: 1, oe: 0, ms: 2, me: 2 }], new Set(), new Set([2])), "a\r\nX\r\nb\r\n");
  assert.equal(applyChanges("a\nb", "a\nb\nc", [{ os: 2, oe: 0, ms: 3, me: 3 }], new Set(), new Set([3])), "a\nb\nc");
  // deletion at the top
  assert.equal(applyChanges("x\ny\n", "y\n", [{ os: 1, oe: 1, ms: 0, me: 0 }], new Set([1]), new Set()), "y\n");
});

test("pickLines", () => {
  const ch = [{ os: 2, oe: 3, ms: 2, me: 2 }, { os: 6, oe: 6, ms: 5, me: 0 }];
  assert.deepEqual(pickLines(ch, new Set([2]), false), { removed: new Set([2, 3]), added: new Set([2]) });
  assert.deepEqual(pickLines(ch, new Set([6]), false), { removed: new Set([6]), added: new Set() });
  assert.deepEqual(pickLines(ch, new Set([3]), true), { removed: new Set([3]), added: new Set() });
});

test("layoutGraph: branch and merge", () => {
  // M merges B into A; A and B fork from R
  const g = layoutGraph([
    { hash: "M", parents: ["A", "B"] },
    { hash: "B", parents: ["R"] },
    { hash: "A", parents: ["R"] },
    { hash: "R", parents: [] },
  ]);
  assert.deepEqual(g.nodes, [0, 1, 0, 0]);
  assert.equal(g.width, 2);
  const bToR = g.edges.find((e) => e.row === 1);
  assert.deepEqual([bToR.via, bToR.toRow, bToR.toLane], [1, 3, 0]);
});

test("parseConflicts + mergeSides: picks in click order, base when none", () => {
  const text = "a\n<<<<<<< current\nX\n||||||| base\nB\n=======\nY1\nY2\n>>>>>>> incoming\nz\n";
  const chunks = parseConflicts(text);
  assert.deepEqual(chunks, [["a\n"], { cur: ["X\n"], base: ["B\n"], inc: ["Y1\n", "Y2\n"] }, ["z\n"]]);
  const none = mergeSides(chunks, []);
  assert.equal(none.a, "a\nX\nz\n");
  assert.equal(none.b, "a\nY1\nY2\nz\n");
  assert.equal(none.out, "a\nB\nz\n");
  assert.deepEqual(none.regions, [{ a: [2, 1], b: [2, 2], out: [2, 1] }]);
  const both = mergeSides(chunks, [["b", "a"]]);
  assert.equal(both.out, "a\nY1\nY2\nX\nz\n");
  assert.deepEqual(both.regions[0].out, [2, 3]);
});

test("parseBlame: details from a commit's first header, one entry per line", () => {
  const a = "a".repeat(40), b = "b".repeat(40);
  const text = [
    `${a} 1 1 1`, "author Ann Lee", "author-time 100", "summary first", "filename f.c", "\tx",
    `${b} 1 2 1`, "author Bob", "author-time 200", "summary second", "filename f.c", "\tauthor not a header",
    `${a} 2 3`, "\tz", "",
  ].join("\n");
  const lines = parseBlame(text);
  assert.deepEqual(lines.map((l) => l.hash), [a, b, a]);
  assert.deepEqual(lines[2], { hash: a, author: "Ann Lee", time: 100, summary: "first" });
  assert.equal(lines[1].author, "Bob");
});

test("sprite: same name same sprite, mirrored, eyes open, names differ", () => {
  const a = sprite("Ann Lee");
  assert.deepEqual(sprite("Ann Lee"), a);
  assert.ok(a.cells.every((row) => row.length === 7 && row.join() === [...row].reverse().join()));
  assert.equal(a.cells[2][1], false);
  assert.equal(a.cells[1][1] && a.cells[3][1] && a.cells[2][0] && a.cells[2][2], true);
  assert.notDeepEqual(sprite("Bob Martin"), a);
});
